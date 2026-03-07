using NativeDeviceService.Models;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Audio routing service – stub ready for a real implementation.
// Future implementation should use NAudio (Windows) or cross-platform PortAudio.
// ---------------------------------------------------------------------------

/// <summary>Contract for audio device management and routing.</summary>
public interface IAudioService
{
    /// <summary>Return all detected audio input/output devices.</summary>
    Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync();

    /// <summary>Route audio output to the specified device.</summary>
    Task<bool> SetOutputDeviceAsync(string deviceId);

    /// <summary>Route audio input from the specified device.</summary>
    Task<bool> SetInputDeviceAsync(string deviceId);
}

/// <summary>
/// Stub implementation – no audio routing is performed yet.
/// Replace with NAudio or OS-level audio API calls when ready.
/// </summary>
public sealed class AudioService : IAudioService
{
    public Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync()
    {
        // TODO: Enumerate real audio endpoints via Windows Core Audio (NAudio/MMDeviceAPI).
        IReadOnlyList<DeviceInfo> empty = [];
        return Task.FromResult(empty);
    }

    public Task<bool> SetOutputDeviceAsync(string deviceId)
    {
        // TODO: Switch the default audio playback endpoint.
        Console.WriteLine($"[AudioService] (stub) SetOutput -> {deviceId}");
        return Task.FromResult(true);
    }

    public Task<bool> SetInputDeviceAsync(string deviceId)
    {
        // TODO: Switch the default audio capture endpoint.
        Console.WriteLine($"[AudioService] (stub) SetInput -> {deviceId}");
        return Task.FromResult(true);
    }
}
