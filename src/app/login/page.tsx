import { auth } from "@/auth";
import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/terminal");
  return <LoginForm />;
}
