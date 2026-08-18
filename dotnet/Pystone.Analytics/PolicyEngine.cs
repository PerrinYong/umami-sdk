using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Pystone.Analytics;

internal sealed class EventRegistryDocument
{
    [JsonPropertyName("events")]
    public Dictionary<string, EventDefinition> Events { get; init; } = [];
}

internal sealed class PrivacyPolicyDocument
{
    [JsonPropertyName("policy_version")]
    public int PolicyVersion { get; init; }

    [JsonPropertyName("limits")]
    public Dictionary<string, long> Limits { get; init; } = [];

    [JsonPropertyName("session_properties")]
    public string[] SessionProperties { get; init; } = [];

    [JsonPropertyName("forbidden_key_tokens")]
    public string[] ForbiddenKeyTokens { get; init; } = [];

    [JsonPropertyName("sensitive_value_patterns")]
    public string[] SensitiveValuePatterns { get; init; } = [];

    [JsonPropertyName("allowed_url_query_keys")]
    public string[] AllowedUrlQueryKeys { get; init; } = [];
}

internal sealed class PolicyException(string code, string? detail = null) : Exception(code)
{
    public string Code { get; } = code;
    public string? Detail { get; } = detail;
}

internal sealed class PolicyEngine
{
    private static readonly Regex EventNamePattern = new("^[a-z][a-z0-9_]*$", RegexOptions.CultureInvariant);
    private static readonly Regex PropertyNamePattern = new("^[a-z][a-z0-9_]*$", RegexOptions.CultureInvariant);
    private static readonly Regex SlugPattern = new("^[a-z0-9][a-z0-9_-]*$", RegexOptions.CultureInvariant);
    private static readonly Regex ContextValuePattern = new("^[A-Za-z0-9][A-Za-z0-9._+-]*$", RegexOptions.CultureInvariant);
    private static readonly Regex HostnamePattern = new("^[A-Za-z0-9.-]+$", RegexOptions.CultureInvariant);
    private static readonly Regex SubjectPattern = new("^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant);
    private readonly AnalyticsOptions _options;
    private readonly Dictionary<string, EventDefinition> _events;
    private readonly PrivacyPolicyDocument _policy;
    private readonly HashSet<string> _forbiddenTokens;
    private readonly HashSet<string> _sessionProperties;
    private readonly Regex[] _sensitivePatterns;

    public PolicyEngine(AnalyticsOptions options)
    {
        _options = options;
        var registry = JsonSerializer.Deserialize<EventRegistryDocument>(GeneratedPolicy.EventRegistryJson)
            ?? throw new InvalidOperationException("Invalid embedded event registry.");
        _policy = JsonSerializer.Deserialize<PrivacyPolicyDocument>(GeneratedPolicy.PrivacyPolicyJson)
            ?? throw new InvalidOperationException("Invalid embedded privacy policy.");
        _events = new Dictionary<string, EventDefinition>(registry.Events, StringComparer.Ordinal);
        _forbiddenTokens = new(_policy.ForbiddenKeyTokens, StringComparer.OrdinalIgnoreCase);
        _sessionProperties = new(_policy.SessionProperties, StringComparer.Ordinal);
        _sensitivePatterns = _policy.SensitiveValuePatterns
            .Select(pattern => new Regex(
                pattern,
                RegexOptions.CultureInvariant,
                TimeSpan.FromMilliseconds(100)))
            .ToArray();
        ValidateOptions();
    }

    public (UmamiRequest Request, string EventId) CreateEvent(
        string eventName,
        IReadOnlyDictionary<string, object?> properties,
        string? subjectId,
        DateTimeOffset occurredAt)
    {
        var definition = ValidateEvent(eventName, properties);
        if (subjectId is not null) ValidateSubjectId(subjectId);
        var eventId = Guid.NewGuid().ToString("D");
        var data = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["event_version"] = definition.Version,
            ["product"] = _options.Product,
            ["environment"] = _options.Environment,
            ["surface"] = _options.Surface,
            ["product_version"] = _options.ProductVersion,
            ["sdk_version"] = _options.SdkVersion,
            ["consent_state"] = "granted",
            ["policy_version"] = _policy.PolicyVersion,
        };
        AddOptional(data, "platform", _options.Platform);
        AddOptional(data, "architecture", _options.Architecture);
        AddOptional(data, "locale", _options.Locale);
        AddOptional(data, "channel", _options.Channel);
        foreach (var pair in properties) data[pair.Key] = pair.Value;
        if (data.Count > Limit("property_count")) throw new PolicyException("invalid_property", "property_count");

        return (new UmamiRequest
        {
            Type = "event",
            Payload = new UmamiPayload
            {
                Website = _options.WebsiteId.ToString("D"),
                Hostname = _options.Hostname,
                Url = $"/events/{eventName}",
                Name = eventName,
                Id = subjectId,
                Timestamp = occurredAt.ToUnixTimeSeconds(),
                Data = data,
            },
        }, eventId);
    }

    public UmamiRequest CreateIdentify(string subjectId, IReadOnlyDictionary<string, object?> properties)
    {
        ValidateSubjectId(subjectId);
        ValidateProperties(properties, _sessionProperties);
        return new UmamiRequest
        {
            Type = "identify",
            Payload = new UmamiPayload
            {
                Website = _options.WebsiteId.ToString("D"),
                Id = subjectId,
                Data = properties,
            },
        };
    }

    public UmamiRequest CreatePage(string path, string? title, string? subjectId)
    {
        if (subjectId is not null) ValidateSubjectId(subjectId);
        var normalized = NormalizePage(path, title);
        return new UmamiRequest
        {
            Type = "event",
            Payload = new UmamiPayload
            {
                Website = _options.WebsiteId.ToString("D"),
                Hostname = _options.Hostname,
                Url = normalized.Path,
                Title = normalized.Title,
                Id = subjectId,
            },
        };
    }

    public void ValidatePersistedRequest(UmamiRequest request)
    {
        if (!string.Equals(request.Payload.Website, _options.WebsiteId.ToString("D"), StringComparison.Ordinal))
            throw new PolicyException("invalid_property", "queue_website");

        if (request.Type == "identify")
        {
            if (request.Payload.Id is null
                || request.Payload.Data is null
                || request.Payload.Hostname is not null
                || request.Payload.Url is not null
                || request.Payload.Title is not null
                || request.Payload.Name is not null
                || request.Payload.Timestamp is not null)
                throw new PolicyException("invalid_property", "queue_identify");
            ValidateSubjectId(request.Payload.Id);
            ValidateProperties(NormalizePersistedData(request.Payload.Data), _sessionProperties);
            return;
        }

        if (request.Type != "event") throw new PolicyException("invalid_property", "queue_type");
        if (request.Payload.Name is not null)
        {
            if (request.Payload.Hostname != _options.Hostname
                || request.Payload.Url != $"/events/{request.Payload.Name}"
                || request.Payload.Title is not null
                || request.Payload.Timestamp is null
                || request.Payload.Data is null)
                throw new PolicyException("invalid_property", "queue_event");
            if (request.Payload.Id is not null) ValidateSubjectId(request.Payload.Id);
            ValidateCanonicalEventData(request.Payload.Name, NormalizePersistedData(request.Payload.Data));
            return;
        }

        if (request.Payload.Hostname != _options.Hostname
            || request.Payload.Url is null
            || request.Payload.Timestamp is not null
            || request.Payload.Data is not null)
            throw new PolicyException("invalid_property", "queue_page");
        if (request.Payload.Id is not null) ValidateSubjectId(request.Payload.Id);
        var normalized = NormalizePage(request.Payload.Url, request.Payload.Title);
        if (normalized.Path != request.Payload.Url || normalized.Title != request.Payload.Title)
            throw new PolicyException("invalid_property", "queue_page");
    }

    private EventDefinition ValidateEvent(string eventName, IReadOnlyDictionary<string, object?> properties)
    {
        if (!EventNamePattern.IsMatch(eventName) || eventName.Length > Limit("event_name"))
            throw new PolicyException("invalid_event_name");
        if (!_events.TryGetValue(eventName, out var definition))
            throw new PolicyException("unregistered_event");
        foreach (var required in definition.Required)
        {
            if (!properties.ContainsKey(required)) throw new PolicyException("missing_property", required);
        }
        ValidateProperties(properties, new HashSet<string>(definition.Required.Concat(definition.Optional)));
        return definition;
    }

    private void ValidateCanonicalEventData(
        string eventName,
        IReadOnlyDictionary<string, object?> data)
    {
        if (!_events.TryGetValue(eventName, out var definition))
            throw new PolicyException("unregistered_event");
        var eventKeys = new HashSet<string>(definition.Required.Concat(definition.Optional), StringComparer.Ordinal);
        var expectedCommon = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["event_version"] = definition.Version,
            ["product"] = _options.Product,
            ["environment"] = _options.Environment,
            ["surface"] = _options.Surface,
            ["product_version"] = _options.ProductVersion,
            ["sdk_version"] = _options.SdkVersion,
            ["consent_state"] = "granted",
            ["policy_version"] = _policy.PolicyVersion,
        };
        AddOptional(expectedCommon, "platform", _options.Platform);
        AddOptional(expectedCommon, "architecture", _options.Architecture);
        AddOptional(expectedCommon, "locale", _options.Locale);
        AddOptional(expectedCommon, "channel", _options.Channel);

        foreach (var pair in expectedCommon)
        {
            if (!eventKeys.Contains(pair.Key)
                && (!data.TryGetValue(pair.Key, out var value) || !PersistedValuesEqual(value, pair.Value)))
                throw new PolicyException("invalid_property", pair.Key);
        }

        var common = new HashSet<string>(
            new[]
            {
                "event_version", "product", "environment", "surface", "product_version",
                "sdk_version", "platform", "architecture", "locale", "channel",
                "consent_state", "policy_version",
            },
            StringComparer.Ordinal);
        var properties = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var pair in data)
        {
            if (eventKeys.Contains(pair.Key)) properties[pair.Key] = pair.Value;
            else if (!common.Contains(pair.Key) || !expectedCommon.ContainsKey(pair.Key))
                throw new PolicyException("unknown_property", pair.Key);
        }
        ValidateEvent(eventName, properties);
    }

    private static IReadOnlyDictionary<string, object?> NormalizePersistedData(
        IReadOnlyDictionary<string, object?> data)
    {
        var normalized = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var pair in data)
        {
            normalized[pair.Key] = pair.Value is JsonElement element
                ? element.ValueKind switch
                {
                    JsonValueKind.String => element.GetString(),
                    JsonValueKind.Number when element.TryGetInt64(out var integer) => integer,
                    JsonValueKind.Number => element.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Null => null,
                    _ => throw new PolicyException("invalid_property", pair.Key),
                }
                : pair.Value;
        }
        return normalized;
    }

    private static bool PersistedValuesEqual(object? left, object? right)
    {
        if (Equals(left, right)) return true;
        if (left is byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal
            && right is byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal)
        {
            try
            {
                return Convert.ToDecimal(left, CultureInfo.InvariantCulture)
                    == Convert.ToDecimal(right, CultureInfo.InvariantCulture);
            }
            catch (Exception exception) when (exception is OverflowException or FormatException)
            {
                return false;
            }
        }
        return false;
    }

    private void ValidateProperties(
        IReadOnlyDictionary<string, object?> properties,
        IReadOnlySet<string> allowed)
    {
        if (properties.Count > Limit("property_count")) throw new PolicyException("invalid_property", "property_count");
        foreach (var pair in properties)
        {
            if (!allowed.Contains(pair.Key)) throw new PolicyException("unknown_property", pair.Key);
            ValidateKey(pair.Key);
            ValidateValue(pair.Key, pair.Value);
        }
    }

    private void ValidateKey(string key)
    {
        if (!PropertyNamePattern.IsMatch(key) || key.Length > Limit("property_name"))
            throw new PolicyException("invalid_property", key);
        var tokens = key.Split(['_', '-', '.'], StringSplitOptions.RemoveEmptyEntries);
        if (_forbiddenTokens.Contains(key) || tokens.Any(_forbiddenTokens.Contains))
            throw new PolicyException("sensitive_key", key);
    }

    private void ValidateValue(string key, object? value)
    {
        if (value is null or bool) return;
        if (value is byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal)
        {
            try
            {
                var number = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
                if (Math.Abs(number) > Limit("number_absolute")
                    || decimal.Round(number, checked((int)Limit("number_decimal_places"))) != number)
                    throw new PolicyException("invalid_property", key);
            }
            catch (Exception exception) when (exception is OverflowException or FormatException)
            {
                throw new PolicyException("invalid_property", key);
            }
            return;
        }
        if (value is not string textValue || textValue.Length > Limit("string_value"))
            throw new PolicyException("invalid_property", key);
        if (ContainsSensitiveValue(textValue)) throw new PolicyException("sensitive_value", key);
    }

    private void ValidateSubjectId(string subjectId)
    {
        if (string.IsNullOrWhiteSpace(subjectId)
            || subjectId.Length > Limit("subject_id")
            || !SubjectPattern.IsMatch(subjectId)
            || ContainsSensitiveValue(subjectId))
            throw new PolicyException("invalid_subject_id");
    }

    private (string Path, string? Title) NormalizePage(string path, string? title)
    {
        if (!Uri.TryCreate(new Uri("https://analytics.invalid"), path, out var uri))
            throw new PolicyException("invalid_page", "path");
        var query = new List<string>();
        if (_options.AllowUtm && !string.IsNullOrEmpty(uri.Query))
        {
            var allowed = new HashSet<string>(_policy.AllowedUrlQueryKeys, StringComparer.Ordinal);
            foreach (var component in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var pair = component.Split('=', 2);
                var key = Uri.UnescapeDataString(pair[0]);
                var value = pair.Length > 1 ? Uri.UnescapeDataString(pair[1]) : string.Empty;
                if (allowed.Contains(key) && value.Length <= 100 && !ContainsSensitiveValue(value))
                    query.Add($"{Uri.EscapeDataString(key)}={Uri.EscapeDataString(value)}");
            }
        }
        var result = uri.AbsolutePath + (query.Count > 0 ? $"?{string.Join('&', query)}" : string.Empty);
        if (result.Length > Limit("page_path")) throw new PolicyException("invalid_page", "path_length");
        if ((title?.Length ?? 0) > Limit("page_title") || (title is not null && ContainsSensitiveValue(title)))
            throw new PolicyException("invalid_page", "title");
        return (result, title);
    }

    private bool ContainsSensitiveValue(string value) => _sensitivePatterns.Any(pattern => pattern.IsMatch(value));
    private long Limit(string name) => _policy.Limits[name];

    private void ValidateOptions()
    {
        if (!_options.Endpoint.IsAbsoluteUri) throw new ArgumentException("Endpoint must be absolute.");
        var localhost = _options.Endpoint.Host is "localhost" or "127.0.0.1" or "::1";
        if (_options.Endpoint.Scheme != Uri.UriSchemeHttps
            && !(_options.AllowInsecureLocalhost && localhost && _options.Endpoint.Scheme == Uri.UriSchemeHttp))
            throw new ArgumentException("Endpoint must use HTTPS except explicit localhost development.");
        if (!string.IsNullOrEmpty(_options.Endpoint.UserInfo)
            || _options.Endpoint.PathAndQuery != "/"
            || !string.IsNullOrEmpty(_options.Endpoint.Fragment))
            throw new ArgumentException("Endpoint must not contain a path, query or fragment.");
        foreach (var value in new[] { _options.Product, _options.Environment, _options.Surface })
        {
            if (!SlugPattern.IsMatch(value) || value.Length > 64) throw new ArgumentException("Invalid product context slug.");
        }
        if (string.IsNullOrWhiteSpace(_options.Hostname)
            || _options.Hostname.Length > 253
            || !HostnamePattern.IsMatch(_options.Hostname))
            throw new ArgumentException("Invalid hostname.");
        foreach (var value in new[]
        {
            _options.ProductVersion,
            _options.SdkVersion,
            _options.Platform,
            _options.Architecture,
            _options.Locale,
            _options.Channel,
        })
        {
            if (value is not null && (!ContextValuePattern.IsMatch(value) || value.Length > 64))
                throw new ArgumentException("Invalid analytics context value.");
        }
        if (string.IsNullOrWhiteSpace(_options.UserAgent)
            || _options.UserAgent.Length > 200
            || _options.UserAgent.IndexOfAny(['\r', '\n']) >= 0)
            throw new ArgumentException("Invalid UserAgent.");
        if (_options.PolicyVersion != _policy.PolicyVersion) throw new ArgumentException("Policy version mismatch.");
        if (_options.QueueCapacity is < 1 or > 10_000 || _options.BatchSize is < 1 or > 100)
            throw new ArgumentOutOfRangeException(nameof(_options.QueueCapacity));
        if (_options.FlushInterval <= TimeSpan.Zero
            || _options.FlushInterval > TimeSpan.FromDays(1)
            || _options.Timeout <= TimeSpan.Zero
            || _options.Timeout > TimeSpan.FromMinutes(1)
            || _options.MaxRetries is < 0 or > 10
            || _options.MaxEventAge <= TimeSpan.Zero
            || _options.MaxEventAge > TimeSpan.FromDays(30)
            || _options.RetryBase <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(_options.Timeout));
    }

    private static void AddOptional(IDictionary<string, object?> target, string key, string? value)
    {
        if (!string.IsNullOrEmpty(value)) target[key] = value;
    }
}
