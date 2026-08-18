using System.Text.Json.Serialization;

namespace Pystone.Analytics;

public enum ConsentState
{
    Unknown,
    Granted,
    Denied,
    Withdrawn,
}

public sealed record AnalyticsDiagnostic(string Code, string? EventName = null, string? Detail = null);

public sealed record AnalyticsResult(bool Accepted, string Code, string? EventId = null)
{
    public static AnalyticsResult Success(string? eventId = null) => new(true, "accepted", eventId);
    public static AnalyticsResult Rejected(string code) => new(false, code);
}

internal sealed class EventDefinition
{
    [JsonPropertyName("version")]
    public int Version { get; init; }

    [JsonPropertyName("purpose")]
    public string Purpose { get; init; } = string.Empty;

    [JsonPropertyName("identity_scope")]
    public string IdentityScope { get; init; } = string.Empty;

    [JsonPropertyName("required")]
    public string[] Required { get; init; } = [];

    [JsonPropertyName("optional")]
    public string[] Optional { get; init; } = [];
}

public sealed class AnalyticsOptions
{
    public required Uri Endpoint { get; init; }
    public required Guid WebsiteId { get; init; }
    public required string Hostname { get; init; }
    public required string Product { get; init; }
    public required string Environment { get; init; }
    public required string Surface { get; init; }
    public required string ProductVersion { get; init; }
    public required string UserAgent { get; init; }
    public string SdkVersion { get; init; } = "0.1.1";
    public string? Platform { get; init; }
    public string? Architecture { get; init; }
    public string? Locale { get; init; }
    public string? Channel { get; init; }
    public int PolicyVersion { get; init; } = 1;
    public ConsentState InitialConsent { get; init; } = ConsentState.Unknown;
    public bool AllowInsecureLocalhost { get; init; }
    public bool AllowUtm { get; init; }
    public int QueueCapacity { get; init; } = 1_000;
    public int BatchSize { get; init; } = 25;
    public TimeSpan FlushInterval { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(3);
    public int MaxRetries { get; init; } = 3;
    public TimeSpan MaxEventAge { get; init; } = TimeSpan.FromHours(24);
    public TimeSpan RetryBase { get; init; } = TimeSpan.FromMilliseconds(500);
    public string? PersistentQueuePath { get; init; }
    public Action<AnalyticsDiagnostic>? OnDiagnostic { get; init; }
}

public interface IAnalyticsClient : IAsyncDisposable
{
    AnalyticsResult Track(string eventName, IReadOnlyDictionary<string, object?>? properties = null);
    AnalyticsResult Identify(string subjectId, IReadOnlyDictionary<string, object?>? properties = null);
    AnalyticsResult Page(string path = "/", string? title = null);
    void SetConsent(ConsentState state);
    Task FlushAsync(CancellationToken cancellationToken = default);
    void Disable();
}

public sealed class UmamiRequest
{
    [JsonPropertyName("type")]
    public required string Type { get; init; }

    [JsonPropertyName("payload")]
    public required UmamiPayload Payload { get; init; }
}

public sealed class UmamiPayload
{
    [JsonPropertyName("website")]
    public required string Website { get; init; }

    [JsonPropertyName("hostname")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Hostname { get; init; }

    [JsonPropertyName("url")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Url { get; init; }

    [JsonPropertyName("title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Title { get; init; }

    [JsonPropertyName("name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; init; }

    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; init; }

    [JsonPropertyName("timestamp")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? Timestamp { get; init; }

    [JsonPropertyName("data")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, object?>? Data { get; init; }
}

public enum TransportOutcome
{
    Success,
    Retryable,
    Permanent,
}

public sealed record TransportResult(
    TransportOutcome Outcome,
    TimeSpan? RetryAfter = null,
    int PartialErrors = 0);

public interface IAnalyticsTransport
{
    Task<TransportResult> SendAsync(
        IReadOnlyList<UmamiRequest> requests,
        CancellationToken cancellationToken = default);

    void ResetSession() { }
}
