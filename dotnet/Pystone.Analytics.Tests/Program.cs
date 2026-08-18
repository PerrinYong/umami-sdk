using Pystone.Analytics;
using System.Collections;
using System.Diagnostics;
using System.Net;
using System.Text;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var transport = new FakeTransport();
var diagnostics = new List<AnalyticsDiagnostic>();
var options = new AnalyticsOptions
{
    Endpoint = new("https://umami.example.test"),
    WebsiteId = Guid.Parse("123e4567-e89b-42d3-a456-426614174000"),
    Hostname = "desktop.example.test",
    Product = "test-product",
    Environment = "staging",
    Surface = "desktop",
    ProductVersion = "1.0.0",
    UserAgent = "Test/1.0 Analytics/0.1.1",
    FlushInterval = TimeSpan.FromHours(1),
    OnDiagnostic = diagnostics.Add,
};

await using (var client = new AnalyticsClient(options, transport))
{
    Assert(client.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" }).Code
        == "consent_not_granted", "Unknown consent must reject.");
    client.SetConsent(ConsentState.Granted);
    var accepted = client.Track("operation_completed", new Dictionary<string, object?>
    {
        ["feature"] = "scan",
        ["duration_bucket"] = "1_3s",
    });
    Assert(accepted.Accepted && accepted.EventId is not null, "Valid event must be accepted.");
    Assert(!client.Track("feature_used", new Dictionary<string, object?>
    {
        ["feature"] = "person@example.com",
    }).Accepted, "Sensitive value must be rejected.");
    Assert(client.Identify("valid_subject_id", new Dictionary<string, object?>
    {
        ["plan"] = "free",
    }).Accepted, "Valid identity must be accepted.");
    await client.FlushAsync();
    Assert(transport.Batches.Count == 1, "Batch must be sent.");
    Assert(client.PendingCount == 0, "Queue must drain on success.");
}

var installationA = AnalyticsIdentity.DeriveInstallationSubjectId("product-a", "installation");
var installationB = AnalyticsIdentity.DeriveInstallationSubjectId("product-b", "installation");
Assert(installationA.Length == 43 && installationA != installationB, "Installation IDs must be scoped.");
Assert(AnalyticsIdentity.DeriveUserSubjectId(new byte[32], "user-1").Length == 43, "User ID must fit Umami.");

var retryTransport = new FakeTransport();
retryTransport.Results.Enqueue(new(TransportOutcome.Retryable));
var retryOptions = new AnalyticsOptions
{
    Endpoint = options.Endpoint,
    WebsiteId = options.WebsiteId,
    Hostname = options.Hostname,
    Product = options.Product,
    Environment = options.Environment,
    Surface = options.Surface,
    ProductVersion = options.ProductVersion,
    UserAgent = options.UserAgent,
    InitialConsent = ConsentState.Granted,
    FlushInterval = TimeSpan.FromHours(1),
    RetryBase = TimeSpan.FromSeconds(30),
};
await using (var client = new AnalyticsClient(retryOptions, retryTransport))
{
    client.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" });
    await client.FlushAsync();
    Assert(client.PendingCount == 1, "Retryable failure must keep the item.");
    client.SetConsent(ConsentState.Withdrawn);
    Assert(client.PendingCount == 0, "Withdrawal must clear the queue.");
    Assert(retryTransport.Resets == 1, "Withdrawal must reset the Umami session cache.");
}

var blockingTransport = new BlockingTransport();
var asynchronousOptions = new AnalyticsOptions
{
    Endpoint = options.Endpoint,
    WebsiteId = options.WebsiteId,
    Hostname = options.Hostname,
    Product = options.Product,
    Environment = options.Environment,
    Surface = options.Surface,
    ProductVersion = options.ProductVersion,
    UserAgent = options.UserAgent,
    InitialConsent = ConsentState.Granted,
    FlushInterval = TimeSpan.FromHours(1),
};
await using (var client = new AnalyticsClient(asynchronousOptions, blockingTransport))
{
    var result = client.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" });
    Assert(result.Accepted, "Track must return after local enqueue.");
    await blockingTransport.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
    Assert(!blockingTransport.Completed, "Blocked network must remain on the background worker.");
    client.Disable();
}

var queueDirectory = Path.Combine(Path.GetTempPath(), $"pystone-analytics-{Guid.NewGuid():N}");
var queuePath = Path.Combine(queueDirectory, "queue.json");
try
{
    var persistentTransport = new FakeTransport();
    persistentTransport.Results.Enqueue(new(TransportOutcome.Retryable));
    var persistentOptions = new AnalyticsOptions
    {
        Endpoint = options.Endpoint,
        WebsiteId = options.WebsiteId,
        Hostname = options.Hostname,
        Product = options.Product,
        Environment = options.Environment,
        Surface = options.Surface,
        ProductVersion = options.ProductVersion,
        UserAgent = options.UserAgent,
        InitialConsent = ConsentState.Granted,
        FlushInterval = TimeSpan.FromHours(1),
        RetryBase = TimeSpan.FromMinutes(1),
        PersistentQueuePath = queuePath,
    };
    await using (var first = new AnalyticsClient(persistentOptions, persistentTransport))
    {
        first.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" });
        await first.FlushAsync();
        Assert(File.Exists(queuePath), "Retryable queue must be persisted.");
    }
    await using (var second = new AnalyticsClient(persistentOptions, new FakeTransport()))
    {
        Assert(second.PendingCount == 1, "Persistent queue must be restored.");
        second.SetConsent(ConsentState.Withdrawn);
        Assert(!File.Exists(queuePath), "Withdrawal must delete persistent queue.");
    }
}
finally
{
    if (Directory.Exists(queueDirectory)) Directory.Delete(queueDirectory, true);
}

var tamperDirectory = Path.Combine(Path.GetTempPath(), $"pystone-analytics-tamper-{Guid.NewGuid():N}");
var tamperPath = Path.Combine(tamperDirectory, "queue.json");
try
{
    var tamperTransport = new FakeTransport();
    tamperTransport.Results.Enqueue(new(TransportOutcome.Retryable));
    var tamperOptions = new AnalyticsOptions
    {
        Endpoint = options.Endpoint,
        WebsiteId = options.WebsiteId,
        Hostname = options.Hostname,
        Product = options.Product,
        Environment = options.Environment,
        Surface = options.Surface,
        ProductVersion = options.ProductVersion,
        UserAgent = options.UserAgent,
        InitialConsent = ConsentState.Granted,
        FlushInterval = TimeSpan.FromHours(1),
        RetryBase = TimeSpan.FromMinutes(1),
        PersistentQueuePath = tamperPath,
    };
    await using (var first = new AnalyticsClient(tamperOptions, tamperTransport))
    {
        first.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" });
        await first.FlushAsync();
    }
    var tampered = File.ReadAllText(tamperPath).Replace(
        "\"feature\":\"scan\"",
        "\"feature\":\"person@example.com\"",
        StringComparison.Ordinal);
    File.WriteAllText(tamperPath, tampered);
    var tamperDiagnostics = new List<AnalyticsDiagnostic>();
    var validationOptions = CopyOptions(tamperOptions, onDiagnostic: tamperDiagnostics.Add);
    await using var second = new AnalyticsClient(validationOptions, new FakeTransport());
    Assert(second.PendingCount == 0, "A tampered queue must not be loaded.");
    Assert(!File.Exists(tamperPath), "A tampered queue must be deleted.");
    Assert(tamperDiagnostics.Any(item => item.Detail == "queue_corrupt"),
        "A tampered queue must produce a safe diagnostic.");
}
finally
{
    if (Directory.Exists(tamperDirectory)) Directory.Delete(tamperDirectory, true);
}

var boundedDiagnostics = 0;
var boundedOptions = CopyOptions(options, initialConsent: ConsentState.Granted, queueCapacity: 3);
boundedOptions = CopyOptions(
    boundedOptions,
    onDiagnostic: _ =>
    {
        boundedDiagnostics++;
        throw new InvalidOperationException("host diagnostic failure");
    });
await using (var client = new AnalyticsClient(boundedOptions, new FakeTransport()))
{
    for (var index = 0; index < 10_000; index++)
        Assert(client.Track("feature_used", new Dictionary<string, object?>
        {
            ["feature"] = $"scan_{index}",
        }).Accepted, "Queue overflow must not reject the host call.");
    Assert(client.PendingCount <= 3, "The in-memory queue must remain bounded.");
    Assert(boundedDiagnostics > 0, "Queue overflow must emit a diagnostic.");
}

var concurrentOptions = CopyOptions(options, initialConsent: ConsentState.Granted);
await using (var client = new AnalyticsClient(concurrentOptions, new FakeTransport()))
{
    var properties = new BlockingProperties("feature", "scan");
    var tracking = Task.Run(() => client.Track("feature_used", properties));
    await properties.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
    var withdrawal = Task.Run(() => client.SetConsent(ConsentState.Withdrawn));
    properties.Release.TrySetResult(true);
    Assert((await tracking).Accepted, "The event started before withdrawal should finish locally.");
    await withdrawal;
    Assert(client.PendingCount == 0, "Withdrawal racing with Track must leave no queued event.");
}

var neverTransport = new NeverCompletingTransport();
var deadlineOptions = CopyOptions(
    options,
    initialConsent: ConsentState.Granted,
    timeout: TimeSpan.FromMilliseconds(100));
var deadlineClient = new AnalyticsClient(deadlineOptions, neverTransport);
deadlineClient.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" });
await neverTransport.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
var disposeTimer = Stopwatch.StartNew();
await deadlineClient.DisposeAsync();
Assert(disposeTimer.Elapsed < TimeSpan.FromSeconds(1), "Dispose must not wait for an uncooperative transport.");
await deadlineClient.DisposeAsync();
Assert(deadlineClient.Track("feature_used", new Dictionary<string, object?>
{
    ["feature"] = "scan",
}).Code == "disabled", "Disposed clients must reject future events.");

var synchronouslyBlockingTransport = new SynchronouslyBlockingTransport();
var synchronousDeadlineClient = new AnalyticsClient(deadlineOptions, synchronouslyBlockingTransport);
synchronousDeadlineClient.Track("feature_used", new Dictionary<string, object?> { ["feature"] = "scan" });
await synchronouslyBlockingTransport.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
var synchronousDisposeTimer = Stopwatch.StartNew();
await synchronousDeadlineClient.DisposeAsync();
Assert(synchronousDisposeTimer.Elapsed < TimeSpan.FromSeconds(1),
    "Dispose must bound a custom transport that blocks before returning its Task.");
synchronouslyBlockingTransport.Release.Set();

AssertThrows<ArgumentOutOfRangeException>(() => new AnalyticsClient(
    CopyOptions(options, queueCapacity: 10_001), new FakeTransport()));
AssertThrows<ArgumentOutOfRangeException>(() => new AnalyticsClient(
    CopyOptions(options, maxRetries: 11), new FakeTransport()));
AssertThrows<ArgumentOutOfRangeException>(() => new AnalyticsClient(
    CopyOptions(options, timeout: TimeSpan.FromSeconds(61)), new FakeTransport()));
AssertThrows<ArgumentOutOfRangeException>(() => new AnalyticsClient(
    CopyOptions(options, maxEventAge: TimeSpan.FromDays(30) + TimeSpan.FromMilliseconds(1)),
    new FakeTransport()));
AssertThrows<ArgumentOutOfRangeException>(() => new AnalyticsClient(
    CopyOptions(options, retryBase: TimeSpan.FromDays(1) + TimeSpan.FromMilliseconds(1)),
    new FakeTransport()));
AssertThrows<ArgumentException>(() => new AnalyticsClient(
    CopyOptions(options, websiteId: Guid.Empty), new FakeTransport()));
AssertThrows<ArgumentException>(() => new AnalyticsClient(
    CopyOptions(options, initialConsent: (ConsentState)999), new FakeTransport()));

var httpHandler = new ScriptedHttpHandler(
    new(HttpStatusCode.OK) { Content = new StringContent("not-json", Encoding.UTF8, "application/json") },
    new(HttpStatusCode.OK) { Content = new StringContent(new string('x', 65 * 1024)) },
    new(HttpStatusCode.RequestTimeout),
    new(HttpStatusCode.TooManyRequests),
    new(HttpStatusCode.ServiceUnavailable),
    new(HttpStatusCode.BadRequest));
using (var httpClient = new HttpClient(httpHandler))
using (var httpTransport = new UmamiHttpTransport(options, httpClient))
{
    var request = new UmamiRequest
    {
        Type = "event",
        Payload = new UmamiPayload { Website = options.WebsiteId.ToString("D") },
    };
    Assert((await httpTransport.SendAsync([request])).Outcome == TransportOutcome.Success,
        "Malformed success JSON must not duplicate accepted events.");
    Assert((await httpTransport.SendAsync([request])).Outcome == TransportOutcome.Success,
        "Oversized success bodies must be ignored safely.");
    Assert((await httpTransport.SendAsync([request])).Outcome == TransportOutcome.Retryable,
        "HTTP 408 must be retryable.");
    Assert((await httpTransport.SendAsync([request])).Outcome == TransportOutcome.Retryable,
        "HTTP 429 must be retryable.");
    Assert((await httpTransport.SendAsync([request])).Outcome == TransportOutcome.Retryable,
        "HTTP 5xx must be retryable.");
    Assert((await httpTransport.SendAsync([request])).Outcome == TransportOutcome.Permanent,
        "Other HTTP 4xx must be permanent.");
}

Console.WriteLine("Pystone.Analytics .NET tests passed.");

static AnalyticsOptions CopyOptions(
    AnalyticsOptions source,
    ConsentState? initialConsent = null,
    int? queueCapacity = null,
    int? maxRetries = null,
    TimeSpan? timeout = null,
    TimeSpan? maxEventAge = null,
    TimeSpan? retryBase = null,
    Guid? websiteId = null,
    Action<AnalyticsDiagnostic>? onDiagnostic = null) => new()
{
    Endpoint = source.Endpoint,
    WebsiteId = websiteId ?? source.WebsiteId,
    Hostname = source.Hostname,
    Product = source.Product,
    Environment = source.Environment,
    Surface = source.Surface,
    ProductVersion = source.ProductVersion,
    UserAgent = source.UserAgent,
    SdkVersion = source.SdkVersion,
    Platform = source.Platform,
    Architecture = source.Architecture,
    Locale = source.Locale,
    Channel = source.Channel,
    PolicyVersion = source.PolicyVersion,
    InitialConsent = initialConsent ?? source.InitialConsent,
    AllowInsecureLocalhost = source.AllowInsecureLocalhost,
    AllowUtm = source.AllowUtm,
    QueueCapacity = queueCapacity ?? source.QueueCapacity,
    BatchSize = source.BatchSize,
    MaxRetries = maxRetries ?? source.MaxRetries,
    Timeout = timeout ?? source.Timeout,
    FlushInterval = TimeSpan.FromHours(1),
    MaxEventAge = maxEventAge ?? source.MaxEventAge,
    RetryBase = retryBase ?? source.RetryBase,
    PersistentQueuePath = source.PersistentQueuePath,
    OnDiagnostic = onDiagnostic ?? source.OnDiagnostic,
};

static void AssertThrows<TException>(Action action) where TException : Exception
{
    try
    {
        action();
        throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
    }
    catch (TException)
    {
    }
}

internal sealed class FakeTransport : IAnalyticsTransport
{
    public List<IReadOnlyList<UmamiRequest>> Batches { get; } = [];
    public Queue<TransportResult> Results { get; } = [];
    public int Resets { get; private set; }

    public Task<TransportResult> SendAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken = default)
    {
        Batches.Add(requests);
        return Task.FromResult(Results.TryDequeue(out var result)
            ? result
            : new TransportResult(TransportOutcome.Success));
    }

    public void ResetSession() => Resets++;
}

internal sealed class BlockingTransport : IAnalyticsTransport
{
    public TaskCompletionSource<bool> Started { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    public bool Completed { get; private set; }

    public async Task<TransportResult> SendAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken = default)
    {
        Started.TrySetResult(true);
        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new(TransportOutcome.Success);
        }
        finally
        {
            Completed = true;
        }
    }
}

internal sealed class NeverCompletingTransport : IAnalyticsTransport
{
    public TaskCompletionSource<bool> Started { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task<TransportResult> SendAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken = default)
    {
        Started.TrySetResult(true);
        return new TaskCompletionSource<TransportResult>(
            TaskCreationOptions.RunContinuationsAsynchronously).Task;
    }
}

internal sealed class SynchronouslyBlockingTransport : IAnalyticsTransport
{
    public TaskCompletionSource<bool> Started { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    public ManualResetEventSlim Release { get; } = new(false);

    public Task<TransportResult> SendAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken = default)
    {
        Started.TrySetResult(true);
        Release.Wait();
        return Task.FromResult(new TransportResult(TransportOutcome.Success));
    }
}

internal sealed class ScriptedHttpHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
{
    private readonly Queue<HttpResponseMessage> _responses = new(responses);

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken) =>
        Task.FromResult(_responses.Dequeue());
}

internal sealed class BlockingProperties(string key, object? value) : IReadOnlyDictionary<string, object?>
{
    public TaskCompletionSource<bool> Started { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource<bool> Release { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int Count => 1;
    public IEnumerable<string> Keys => [key];
    public IEnumerable<object?> Values => [value];
    public object? this[string requestedKey] => requestedKey == key ? value : throw new KeyNotFoundException();

    public bool ContainsKey(string requestedKey)
    {
        Started.TrySetResult(true);
        Release.Task.GetAwaiter().GetResult();
        return requestedKey == key;
    }

    public bool TryGetValue(string requestedKey, out object? result)
    {
        result = requestedKey == key ? value : null;
        return requestedKey == key;
    }

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator()
    {
        yield return new(key, value);
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
