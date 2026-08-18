using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pystone.Analytics;

internal sealed class BatchResponse
{
    [JsonPropertyName("cache")]
    public string? Cache { get; init; }

    [JsonPropertyName("errors")]
    public int Errors { get; init; }
}

public sealed class UmamiHttpTransport : IAnalyticsTransport, IDisposable
{
    private const int MaxResponseBytes = 64 * 1024;
    private readonly HttpClient _httpClient;
    private readonly bool _ownsClient;
    private readonly TimeSpan _timeout;
    private string? _cache;
    private int _sessionGeneration;

    public UmamiHttpTransport(AnalyticsOptions options, HttpClient? httpClient = null)
    {
        _httpClient = httpClient ?? new HttpClient();
        _ownsClient = httpClient is null;
        _httpClient.BaseAddress = options.Endpoint;
        _httpClient.DefaultRequestHeaders.UserAgent.Clear();
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd(options.UserAgent);
        _timeout = options.Timeout;
    }

    public async Task<TransportResult> SendAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken = default)
    {
        if (requests.Count == 0) return new(TransportOutcome.Success);
        var generation = Volatile.Read(ref _sessionGeneration);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_timeout);
        try
        {
            using var message = new HttpRequestMessage(HttpMethod.Post, "api/batch")
            {
                Content = JsonContent.Create(requests),
            };
            var cache = Volatile.Read(ref _cache);
            if (!string.IsNullOrEmpty(cache)) message.Headers.TryAddWithoutValidation("x-umami-cache", cache);
            using var response = await _httpClient.SendAsync(
                message,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                var body = await ReadResponseAsync(response, timeout.Token).ConfigureAwait(false);
                if (generation == Volatile.Read(ref _sessionGeneration) && IsValidCache(body?.Cache))
                    Volatile.Write(ref _cache, body!.Cache);
                return new(TransportOutcome.Success, PartialErrors: body?.Errors ?? 0);
            }
            if (response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
                || (int)response.StatusCode >= 500)
            {
                var retryAfter = response.Headers.RetryAfter?.Delta;
                return new(TransportOutcome.Retryable, retryAfter);
            }
            return new(TransportOutcome.Permanent);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new(TransportOutcome.Retryable);
        }
        catch (HttpRequestException)
        {
            return new(TransportOutcome.Retryable);
        }
    }

    public void Dispose()
    {
        if (_ownsClient) _httpClient.Dispose();
    }

    public void ResetSession()
    {
        Interlocked.Increment(ref _sessionGeneration);
        Volatile.Write(ref _cache, null);
    }

    private static bool IsValidCache(string? value) =>
        value is { Length: > 0 and <= 2048 }
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or '.');

    private static async Task<BatchResponse?> ReadResponseAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var buffer = new byte[MaxResponseBytes + 1];
            var total = 0;
            while (total < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(total, buffer.Length - total), cancellationToken)
                    .ConfigureAwait(false);
                if (read == 0) break;
                total += read;
            }
            if (total == 0 || total > MaxResponseBytes) return null;
            return JsonSerializer.Deserialize<BatchResponse>(buffer.AsSpan(0, total));
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
