"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginForm() {
  const [loading, setLoading] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border/60 shadow-2xl">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-2xl">
            📈
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">
            Sign in to SMDApp
          </CardTitle>
          <CardDescription>
            Access the real-time options intelligence terminal for Indian indices.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            className="w-full"
            size="lg"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              await signIn("google", { callbackUrl: "/terminal" });
            }}
          >
            {loading ? "Redirecting…" : "Continue with Google"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            By continuing you agree to our Terms of Service and Privacy Policy.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
