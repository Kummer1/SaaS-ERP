// Automated Deno test proving ROADMAP Success Criterion 1: an unauthenticated
// GET request to the deployed health Edge Function's public URL returns HTTP
// 200 with a { status: "ok" } body.
import { assertEquals } from "jsr:@std/assert@1";
import { getHealthUrl } from "./conftest.ts";

Deno.test("GET /functions/v1/health returns 200 with status ok, no auth header", async () => {
  const res = await fetch(getHealthUrl());
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.status, "ok");
});
