// ============================================================================
// MOCK — this is NOT the real Tiny ERP API. It simulates the GET /produtos
// v3 endpoint (docs/03-INTEGRACAO-TINY-ERP.md §4) with zero real data, so
// this quick task's sync-worker can be proven end-to-end without a real
// Tiny client_id/client_secret/access_token (quick-260802-hvz).
//
// GET (any query string)
//   -> ?simulate=401 -> 401 JSON error (mock-only test scaffolding: lets
//      scripts/test-products-sync-pipeline.ts deterministically exercise the
//      401 -> tiny_credentials.status='expired' path without a real expired
//      token)
//   -> missing/malformed Authorization header -> 400 JSON error
//   -> otherwise -> 200 { produtos: [...] }, each product's `nome` embedding
//      the caller's own access token's last-8-characters "tag" — critical
//      for this quick task's cross-tenant isolation test: proves the
//      response (and everything sync-worker stores from it) is tied to
//      whichever specific tenant access token was actually sent, not a
//      hardcoded/shared value.
//
// verify_jwt = false (supabase/config.toml): this endpoint plays the role of
// the real Tiny API, which authenticates via the tenant's own Tiny access
// token (an opaque mock string here), never a Supabase-signed JWT —
// identical rationale to tiny-mock-authorize/tiny-mock-token.
Deno.serve((req) => {
  const url = new URL(req.url);

  if (url.searchParams.get("simulate") === "401") {
    return jsonError("invalid_token", 401);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonError("invalid_request: Authorization: Bearer <token> is required", 400);
  }

  const accessToken = authHeader.slice("Bearer ".length);
  const tag = accessToken.slice(-8);

  return new Response(
    JSON.stringify({
      produtos: [
        {
          id: 900001,
          sku: "MOCK-SKU-1",
          nome: `Produto Mock 1 (token:${tag})`,
          preco: 19.9,
          estoqueAtual: 42,
          atualizadoEm: new Date().toISOString(),
        },
        {
          id: 900002,
          sku: "MOCK-SKU-2",
          nome: `Produto Mock 2 (token:${tag})`,
          preco: 39.5,
          estoqueAtual: 7,
          atualizadoEm: new Date().toISOString(),
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
