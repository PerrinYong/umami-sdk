using System.Security.Cryptography;
using System.Text;

namespace Pystone.Analytics;

public static class AnalyticsIdentity
{
    public static string CreateInstallationId() => Guid.NewGuid().ToString("D");

    public static string DeriveInstallationSubjectId(string productScope, string installationId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(productScope);
        ArgumentException.ThrowIfNullOrWhiteSpace(installationId);
        return Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes($"{productScope}\0{installationId}")));
    }

    public static string DeriveUserSubjectId(ReadOnlySpan<byte> productKey, string internalUserId)
    {
        if (productKey.Length < 32) throw new ArgumentException("Product key must contain at least 32 bytes.", nameof(productKey));
        ArgumentException.ThrowIfNullOrWhiteSpace(internalUserId);
        return Base64Url(HMACSHA256.HashData(productKey, Encoding.UTF8.GetBytes(internalUserId)));
    }

    private static string Base64Url(ReadOnlySpan<byte> value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
