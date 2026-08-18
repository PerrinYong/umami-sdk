using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pystone.Analytics;

internal sealed class QueuedItem
{
    public required string QueueId { get; init; }
    public required UmamiRequest Request { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public int Attempts { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public string? EventName { get; init; }
}

public sealed class AnalyticsClient : IAnalyticsClient
{
    private const long MaxPersistentQueueBytes = 64L * 1024 * 1024;
    private static readonly IReadOnlyDictionary<string, object?> EmptyProperties =
        new Dictionary<string, object?>();
    private readonly AnalyticsOptions _options;
    private readonly PolicyEngine _policy;
    private readonly IAnalyticsTransport _transport;
    private readonly bool _ownsTransport;
    private readonly object _gate = new();
    private readonly List<QueuedItem> _queue = [];
    private readonly SemaphoreSlim _signal = new(0, 1);
    private readonly SemaphoreSlim _flushGate = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Task _worker;
    private ConsentState _consent;
    private string? _subjectId;
    private bool _disabled;
    private int _disposeStarted;

    public AnalyticsClient(AnalyticsOptions options, IAnalyticsTransport? transport = null)
    {
        _options = options;
        _policy = new PolicyEngine(options);
        _transport = transport ?? new UmamiHttpTransport(options);
        _ownsTransport = transport is null;
        _consent = options.InitialConsent;
        if (_consent == ConsentState.Granted) LoadQueue();
        else DeletePersistentQueue();
        _worker = Task.Run(WorkerAsync);
    }

    public int PendingCount
    {
        get { lock (_gate) return _queue.Count; }
    }

    public AnalyticsResult Track(
        string eventName,
        IReadOnlyDictionary<string, object?>? properties = null)
    {
        lock (_gate)
        {
            if (!CanAccept) return RejectState(eventName);
            try
            {
                var (request, eventId) = _policy.CreateEvent(
                    eventName,
                    properties ?? EmptyProperties,
                    _subjectId,
                    DateTimeOffset.UtcNow);
                Enqueue(request, eventName, eventId);
                return AnalyticsResult.Success(eventId);
            }
            catch (PolicyException exception)
            {
                Emit(new(exception.Code, eventName, exception.Detail));
                return AnalyticsResult.Rejected(exception.Code);
            }
            catch
            {
                Emit(new("invalid_property", eventName));
                return AnalyticsResult.Rejected("invalid_property");
            }
        }
    }

    public AnalyticsResult Identify(
        string subjectId,
        IReadOnlyDictionary<string, object?>? properties = null)
    {
        lock (_gate)
        {
            if (!CanAccept) return RejectState();
            try
            {
                var request = _policy.CreateIdentify(subjectId, properties ?? EmptyProperties);
                if (_subjectId is not null && !string.Equals(_subjectId, subjectId, StringComparison.Ordinal))
                {
                    _queue.Clear();
                    ResetTransportSession();
                }
                _subjectId = subjectId;
                Enqueue(request);
                return AnalyticsResult.Success();
            }
            catch (PolicyException exception)
            {
                Emit(new(exception.Code, Detail: exception.Detail));
                return AnalyticsResult.Rejected(exception.Code);
            }
            catch
            {
                Emit(new("invalid_subject_id"));
                return AnalyticsResult.Rejected("invalid_subject_id");
            }
        }
    }

    public AnalyticsResult Page(string path = "/", string? title = null)
    {
        lock (_gate)
        {
            if (!CanAccept) return RejectState();
            try
            {
                Enqueue(_policy.CreatePage(path, title, _subjectId));
                return AnalyticsResult.Success();
            }
            catch (PolicyException exception)
            {
                Emit(new(exception.Code, Detail: exception.Detail));
                return AnalyticsResult.Rejected(exception.Code);
            }
            catch
            {
                Emit(new("invalid_page"));
                return AnalyticsResult.Rejected("invalid_page");
            }
        }
    }

    public void SetConsent(ConsentState state)
    {
        lock (_gate)
        {
            if (_disabled) return;
            _consent = state;
            if (state != ConsentState.Granted)
            {
                _subjectId = null;
                _queue.Clear();
            }
        }
        if (state == ConsentState.Granted)
        {
            Signal();
            return;
        }
        ResetTransportSession();
        DeletePersistentQueue();
    }

    public async Task FlushAsync(CancellationToken cancellationToken = default)
    {
        if (!CanAccept) return;
        await _flushGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            while (CanAccept)
            {
                DropExpired();
                List<QueuedItem> batch;
                lock (_gate)
                {
                    var now = DateTimeOffset.UtcNow;
                    batch = _queue
                        .Where(item => item.NextAttemptAt <= now)
                        .Take(_options.BatchSize)
                        .ToList();
                }
                await PersistQueueAsync(cancellationToken).ConfigureAwait(false);
                if (batch.Count == 0) return;

                TransportResult result;
                try
                {
                    result = await SendBatchAsync(
                        batch.Select(item => item.Request).ToList(),
                        cancellationToken).ConfigureAwait(false);
                }
                catch when (!cancellationToken.IsCancellationRequested)
                {
                    result = new(TransportOutcome.Retryable);
                }

                if (result.Outcome == TransportOutcome.Success)
                {
                    Remove(batch);
                    if (result.PartialErrors > 0)
                        Emit(new("transport_permanent_failure", Detail: $"partial:{result.PartialErrors}"));
                    await PersistQueueAsync(cancellationToken).ConfigureAwait(false);
                    continue;
                }
                if (result.Outcome == TransportOutcome.Permanent)
                {
                    Remove(batch);
                    Emit(new("transport_permanent_failure"));
                    await PersistQueueAsync(cancellationToken).ConfigureAwait(false);
                    continue;
                }

                Emit(new("transport_retryable_failure"));
                var nowRetry = DateTimeOffset.UtcNow;
                foreach (var item in batch)
                {
                    item.Attempts++;
                    if (item.Attempts > _options.MaxRetries)
                    {
                        Remove([item]);
                        Emit(new("retry_exhausted", item.EventName));
                        continue;
                    }
                    var exponential = _options.RetryBase.TotalMilliseconds * Math.Pow(2, item.Attempts - 1);
                    var jitter = exponential * 0.25 * Random.Shared.NextDouble();
                    var delay = TimeSpan.FromMilliseconds(exponential + jitter);
                    if (result.RetryAfter > delay) delay = result.RetryAfter.Value;
                    item.NextAttemptAt = nowRetry + delay;
                }
                await PersistQueueAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            Emit(new("transport_retryable_failure", Detail: "flush"));
        }
        finally
        {
            _flushGate.Release();
        }
    }

    public void Disable()
    {
        lock (_gate)
        {
            _disabled = true;
            _consent = ConsentState.Withdrawn;
            _subjectId = null;
            _queue.Clear();
        }
        ResetTransportSession();
        DeletePersistentQueue();
        _shutdown.Cancel();
        Signal();
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0) return;
        _shutdown.Cancel();
        Signal();
        try { await _worker.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        if (CanAccept)
        {
            using var timeout = new CancellationTokenSource(_options.Timeout);
            try { await FlushAsync(timeout.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        lock (_gate)
        {
            _disabled = true;
            _consent = ConsentState.Withdrawn;
            _subjectId = null;
            _queue.Clear();
        }
        ResetTransportSession();
        if (_ownsTransport && _transport is IDisposable disposable) disposable.Dispose();
        _signal.Dispose();
        _flushGate.Dispose();
        _shutdown.Dispose();
    }

    private bool CanAccept
    {
        get { lock (_gate) return !_disabled && _consent == ConsentState.Granted; }
    }

    private AnalyticsResult RejectState(string? eventName = null)
    {
        var code = _disabled ? "disabled" : "consent_not_granted";
        Emit(new(code, eventName));
        return AnalyticsResult.Rejected(code);
    }

    private void Enqueue(UmamiRequest request, string? eventName = null, string? queueId = null)
    {
        lock (_gate)
        {
            if (_queue.Count >= _options.QueueCapacity)
            {
                _queue.RemoveAt(0);
                Emit(new("queue_full", eventName));
            }
            var now = DateTimeOffset.UtcNow;
            _queue.Add(new QueuedItem
            {
                QueueId = queueId ?? Guid.NewGuid().ToString("D"),
                Request = request,
                CreatedAt = now,
                NextAttemptAt = now,
                EventName = eventName,
            });
        }
        Signal();
    }

    private async Task WorkerAsync()
    {
        while (!_shutdown.IsCancellationRequested)
        {
            try
            {
                using var interval = new CancellationTokenSource(_options.FlushInterval);
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                    _shutdown.Token,
                    interval.Token);
                try { await _signal.WaitAsync(linked.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (interval.IsCancellationRequested) { }
                if (_shutdown.IsCancellationRequested) break;
                await Task.Delay(TimeSpan.FromMilliseconds(50), _shutdown.Token).ConfigureAwait(false);
                await FlushAsync(_shutdown.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                Emit(new("transport_retryable_failure"));
            }
        }
    }

    private void DropExpired()
    {
        List<QueuedItem> expired;
        lock (_gate)
        {
            var cutoff = DateTimeOffset.UtcNow - _options.MaxEventAge;
            expired = _queue.Where(item => item.CreatedAt < cutoff).ToList();
            var ids = expired.Select(item => item.QueueId).ToHashSet(StringComparer.Ordinal);
            _queue.RemoveAll(item => ids.Contains(item.QueueId));
        }
        foreach (var item in expired) Emit(new("event_expired", item.EventName));
    }

    private void Remove(IReadOnlyCollection<QueuedItem> items)
    {
        var ids = items.Select(item => item.QueueId).ToHashSet(StringComparer.Ordinal);
        lock (_gate) _queue.RemoveAll(item => ids.Contains(item.QueueId));
    }

    private void Signal()
    {
        try { _signal.Release(); }
        catch (SemaphoreFullException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task PersistQueueAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_options.PersistentQueuePath)) return;
        try
        {
            List<QueuedItem> snapshot;
            lock (_gate) snapshot = [.. _queue];
            var path = Path.GetFullPath(_options.PersistentQueuePath);
            var directory = Path.GetDirectoryName(path)
                ?? throw new InvalidOperationException("Persistent queue path has no directory.");
            Directory.CreateDirectory(directory);
            if (snapshot.Count == 0)
            {
                if (File.Exists(path)) File.Delete(path);
                return;
            }
            var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
            var bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot);
            if (bytes.LongLength > MaxPersistentQueueBytes)
            {
                Emit(new("transport_retryable_failure", Detail: "queue_persist_oversize"));
                return;
            }
            await File.WriteAllBytesAsync(temporary, bytes, cancellationToken).ConfigureAwait(false);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, true);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            Emit(new("transport_retryable_failure", Detail: "queue_persist"));
        }
    }

    private void LoadQueue()
    {
        if (string.IsNullOrWhiteSpace(_options.PersistentQueuePath)) return;
        var path = Path.GetFullPath(_options.PersistentQueuePath);
        if (!File.Exists(path)) return;
        try
        {
            if (new FileInfo(path).Length > MaxPersistentQueueBytes)
                throw new InvalidDataException("Persistent queue exceeds the size limit.");
            var loaded = JsonSerializer.Deserialize<List<QueuedItem>>(
                File.ReadAllText(path),
                new JsonSerializerOptions
                {
                    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
                }) ?? [];
            var cutoff = DateTimeOffset.UtcNow - _options.MaxEventAge;
            foreach (var item in loaded)
            {
                if (!Guid.TryParseExact(item.QueueId, "D", out _)
                    || item.Attempts < 0
                    || item.Attempts > _options.MaxRetries
                    || !string.Equals(item.EventName, item.Request.Payload.Name, StringComparison.Ordinal))
                    throw new InvalidDataException("Invalid persistent queue metadata.");
                _policy.ValidatePersistedRequest(item.Request);
            }
            lock (_gate)
            {
                _queue.AddRange(loaded
                    .Where(item => item.CreatedAt >= cutoff)
                    .TakeLast(_options.QueueCapacity));
            }
        }
        catch
        {
            try { File.Delete(path); }
            catch { }
            Emit(new("transport_permanent_failure", Detail: "queue_corrupt"));
        }
    }

    private void DeletePersistentQueue()
    {
        if (string.IsNullOrWhiteSpace(_options.PersistentQueuePath)) return;
        try
        {
            var path = Path.GetFullPath(_options.PersistentQueuePath);
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            Emit(new("transport_retryable_failure", Detail: "queue_delete"));
        }
    }

    private void Emit(AnalyticsDiagnostic diagnostic)
    {
        try { _options.OnDiagnostic?.Invoke(diagnostic); }
        catch { }
    }

    private void ResetTransportSession()
    {
        try { _transport.ResetSession(); }
        catch { Emit(new("transport_retryable_failure", Detail: "session_reset")); }
    }

    private async Task<TransportResult> SendBatchAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_options.Timeout);
        // A custom transport can execute synchronously before it returns its Task. Keep that
        // extension point off the SDK worker so an implementation that ignores cancellation
        // still cannot defeat FlushAsync/DisposeAsync deadlines. The built-in transport already
        // yields on HttpClient and does not need the extra thread-pool hop.
        var operation = _ownsTransport
            ? _transport.SendAsync(requests, timeout.Token)
            : Task.Run(
                async () => await _transport.SendAsync(requests, timeout.Token).ConfigureAwait(false),
                CancellationToken.None);
        try
        {
            return await operation.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _ = operation.ContinueWith(
                task => _ = task.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return new(TransportOutcome.Retryable);
        }
    }
}
