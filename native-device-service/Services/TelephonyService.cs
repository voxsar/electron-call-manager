namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Telephony event service – stub ready for a real implementation.
// Future work: integrate with Windows telephony (TAPI) or a SIP stack.
// ---------------------------------------------------------------------------

/// <summary>Call state reported by the telephony layer.</summary>
public enum CallState { Idle, Ringing, Answered, Ended }

/// <summary>Contract for telephony / call-control operations.</summary>
public interface ITelephonyService
{
    /// <summary>Current call state.</summary>
    CallState CurrentState { get; }

    /// <summary>Answer the active incoming call.</summary>
    Task<bool> AnswerCallAsync(string? deviceId);

    /// <summary>Hang up the active call.</summary>
    Task<bool> HangupCallAsync(string? deviceId);
}

/// <summary>
/// Stub implementation – tracks state in memory only.
/// Wire up to a real telephony API (TAPI / SIP) when ready.
/// </summary>
public sealed class TelephonyService : ITelephonyService
{
    public CallState CurrentState { get; private set; } = CallState.Idle;

    public Task<bool> AnswerCallAsync(string? deviceId)
    {
        // TODO: Invoke platform telephony API to answer the call.
        Console.WriteLine($"[TelephonyService] (stub) AnswerCall -> device={deviceId ?? "default"}");
        CurrentState = CallState.Answered;
        return Task.FromResult(true);
    }

    public Task<bool> HangupCallAsync(string? deviceId)
    {
        // TODO: Invoke platform telephony API to hang up the call.
        Console.WriteLine($"[TelephonyService] (stub) HangupCall -> device={deviceId ?? "default"}");
        CurrentState = CallState.Idle;
        return Task.FromResult(true);
    }
}
