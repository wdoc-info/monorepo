import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createApp } from "../app";
import { initDatabase } from "../db";
import { loadConfig } from "../config";

const makeTestDb = () => `./data/test-${crypto.randomUUID()}.db`;

describe("auth flow", () => {
  let databaseUrl: string;
  let lastEmailText = "";
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    databaseUrl = makeTestDb();
    const config = loadConfig();
    const db = initDatabase(databaseUrl);
    app = createApp({
      config: { ...config, databaseUrl },
      db,
      sendEmail: async ({ text }) => {
        lastEmailText = text;
      },
    });
  });

  afterAll(() => {
    try {
      Bun.file(databaseUrl).delete();
    } catch {
      // ignore
    }
  });

  test("login then validate", async () => {
    const email = "user@example.com";
    const loginResponse = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(loginResponse.status).toBe(200);

    const match = lastEmailText.match(/(\d{6})/);
    expect(match).not.toBeNull();
    const code = match?.[1];

    const validateResponse = await app.request("/loginvalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    expect(validateResponse.status).toBe(200);

    const json = await validateResponse.json();
    expect(json.token).toBeDefined();
    expect(json.user.email).toBe(email);
  });

  test("allows CORS preflight for configured origins", async () => {
    const response = await app.request("/login", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4200",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:4200",
    );
  });
});
