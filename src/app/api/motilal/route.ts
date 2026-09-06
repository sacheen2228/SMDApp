import { NextRequest, NextResponse } from "next/server";
import {
  loginWithOTP,
  resendOTP,
  verifyOTP,
  isSessionValid,
  getSessionToken,
  getSessionInfo,
  logout,
  autoLogin,
  MOTILAL_CONFIG,
} from "@/lib/motilal/auth";

// ── POST /api/motilal — login, verify, test connection ──
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, userid, password, dob, otp } = body;

    switch (action) {
      case "login": {
        // If no creds provided, use env vars (auto-login)
        const uid = userid || process.env.MOTILAL_USERID;
        const pw = password || process.env.MOTILAL_PASSWORD;
        const dobVal = dob || process.env.MOTILAL_DOB;

        if (!uid || !pw || !dobVal) {
          return NextResponse.json(
            { error: "userid, password, dob required (or set in .env)" },
            { status: 400 }
          );
        }

        const result = await loginWithOTP(uid, pw, dobVal);

        if (result.success) {
          return NextResponse.json({
            success: true,
            message: result.needsVerification
              ? "OTP sent to registered mobile/email. Enter the 6-digit code."
              : "Login successful and verified",
            token: result.token,
            needsVerification: result.needsVerification || false,
          });
        }

        return NextResponse.json(
          { error: result.error },
          { status: 401 }
        );
      }

      case "auto-login": {
        const result = await autoLogin();
        if (result) {
          return NextResponse.json({
            success: true,
            message: "Auto-login successful. OTP sent to registered mobile/email.",
            needsVerification: true,
          });
        }
        return NextResponse.json(
          { error: "Auto-login failed. Check .env credentials." },
          { status: 401 }
        );
      }

      case "resend-otp": {
        const result = await resendOTP();
        if (result.success) {
          return NextResponse.json({ success: true, message: "OTP sent" });
        }
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      case "verify-otp": {
        if (!otp) {
          return NextResponse.json(
            { error: "otp required (6-digit code)" },
            { status: 400 }
          );
        }

        const result = await verifyOTP(otp);
        if (result.success) {
          const info = getSessionInfo();
          return NextResponse.json({
            success: true,
            message: "OTP verified, session active",
            session: info,
          });
        }
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      case "status": {
        const info = getSessionInfo();
        return NextResponse.json({
          ...info,
          hasApiKey: !!MOTILAL_CONFIG.API_KEY,
          hasSecret: !!MOTILAL_CONFIG.SECRET_KEY,
          vendorId: MOTILAL_CONFIG.VENDOR_ID,
          primaryIp: MOTILAL_CONFIG.PRIMARY_IP,
        });
      }

      case "logout": {
        await logout();
        return NextResponse.json({ success: true, message: "Logged out" });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action" },
          { status: 400 }
        );
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// ── GET /api/motilal — quick status check ──
export async function GET() {
  const info = getSessionInfo();
  return NextResponse.json({
    service: "Motilal Oswal API",
    ...info,
    hasCredentials: !!(
      MOTILAL_CONFIG.API_KEY &&
      MOTILAL_CONFIG.SECRET_KEY &&
      MOTILAL_CONFIG.VENDOR_ID
    ),
    endpoints: {
      login: "POST /api/motilal { action: 'login' } — uses .env creds",
      "auto-login": "POST /api/motilal { action: 'auto-login' }",
      "resend-otp": "POST /api/motilal { action: 'resend-otp' }",
      "verify-otp": "POST /api/motilal { action: 'verify-otp', otp: '123456' }",
      status: "POST /api/motilal { action: 'status' }",
      logout: "POST /api/motilal { action: 'logout' }",
    },
  });
}
