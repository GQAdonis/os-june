import { clearSession } from "@/lib/auth";
import { handleRoute } from "@/lib/http";

export async function POST() {
  return handleRoute(async () => {
    await clearSession();
    return { ok: true };
  });
}
