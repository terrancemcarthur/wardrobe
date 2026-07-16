// Vercel Edge Middleware: when WARDROBE_PASSWORD is set, the whole deployment
// (pages, images, and the import API that spends the OpenAI key) sits behind
// HTTP Basic Auth. Any username works; only the password is checked.
export default function middleware(request) {
  const password = process.env.WARDROBE_PASSWORD;
  if (!password) return;
  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      if (decoded.slice(decoded.indexOf(":") + 1) === password) return;
    } catch {
      // fall through to the 401
    }
  }
  return new Response("Wardrobe requires a password.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Wardrobe", charset="UTF-8"' },
  });
}
