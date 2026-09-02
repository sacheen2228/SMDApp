import { NextRequest, NextResponse } from "next/server";
import {
  loginWithTOTP,
  isSessionValid,
  getSessionToken,
  logout,
  MOTILAL_CONFIG,
} from "@/lib/motilal/auth";
import { getLTP, getIndexLTP, KNOWN_SCRIPS } from "@/lib/motilal/market";

// ── POST /api/motilal — login, test connection, get data ──
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, userid, password, dob } = body;

    switch (action) {
      case "login": {
        if (!userid || !password || !dob) {
          return NextResponse.json(
            { error: "userid, password, dob required" },
            { status: 400 }
          );
        }

        const result = await loginWithTOTP(userid, password, dob);

        if (result.success) {
          // Test by fetching NIFTY LTP
          const token = getSessionToken();
          if (token) {
            const niftyLtp = await getLTP("NSEFO", 26000, token);
            return NextResponse.json({
              success: true,
              message: "Login successful",
              nifty: niftyLtp,
            });
          }
          return NextResponse.json({ success: true, message: "Login successful" });
        }

        return NextResponse.json(
          { error: result.error },
          { status: 401 }
        );
      }

      case "status": {
        return NextResponse.json({
          valid: isSessionValid(),
          hasApiKey: !!MOTILAL_CONFIG.API_KEY,
          hasSecret: !!MOTILAL_CONFIG.SECRET_KEY,
          hasTotp: !!MOTILAL_CONFIG.TOTP_KEY,
          primaryIp: MOTILAL_CONFIG.PRIMARY_IP,
        });
      }

      case "test": {
        const token = getSessionToken();
        if (!token) {
          return NextResponse.json(
            { error: "Not logged in" },
            { status: 401 }
          );
        }

        // Test with NIFTY LTP
        const niftyLtp = await getLTP("NSEFO", 26000, token);
        return NextResponse.json({
          success: true,
          nifty: niftyLtp,
        });
      }

      case "indices": {
        const token = getSessionToken();
        if (!token) {
          return NextResponse.json(
            { error: "Not logged in" },
            { status: 401 }
          );
        }

        const indices = await getIndexLTP(token);
        return NextResponse.json({ success: true, indices });
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
  return NextResponse.json({
    service: "Motilal Oswal API",
    valid: isSessionValid(),
    hasCredentials: !!(
      MOTILAL_CONFIG.API_KEY &&
      MOTILAL_CONFIG.SECRET_KEY &&
      MOTILAL_CONFIG.TOTP_KEY
    ),
    endpoints: {
      login: "POST /api/motilal { action: 'login', userid, password, dob }",
      test: "POST /api/motilal { action: 'test' }",
      indices: "POST /api/motilal { action: 'indices' }",
      status: "POST /api/motilal { action: 'status' }",
      logout: "POST /api/motilal { action: 'logout' }",
    },
  });
}
