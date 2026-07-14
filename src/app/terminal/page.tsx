import TradingDashboard from "@/app/page";
import LogoutButton from "@/components/auth/LogoutButton";

// Protected terminal. Access is gated by middleware (redirects to /login
// when unauthenticated). Renders the existing trading dashboard component
// plus a minimal logout control.
export default function TerminalPage() {
  return (
    <div className="relative min-h-screen">
      <div className="absolute right-4 top-4 z-50">
        <LogoutButton />
      </div>
      <TradingDashboard />
    </div>
  );
}
