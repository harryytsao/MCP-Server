import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Integrations",
    version: "1.0.0",
  });

  async init() {
    const baseUrl = "http://localhost:9998";
    const organizationId = "<your-organization-id>";
    const integrationId = "<your-integration-id>";

    // GET /time-check/current-utc → text/plain
    this.server.tool("getCurrentUtc", {}, async () => {
      const res = await fetch(`${baseUrl}/time-check/current-utc`, {
        headers: {
          "X-Org-Id": organizationId,
        },
      });
      const text = await res.text();
      return {
        content: [{ type: "text", text }],
      };
    });

    // GET /time-check/current-time/{city} → text/plain
    this.server.tool(
      "getTimeByCity",
      { city: z.string() },
      async ({ city }) => {
        const res = await fetch(
          `${baseUrl}/time-check/current-time/${encodeURIComponent(city)}`,
          {
            headers: {
              "X-Org-Id": organizationId,
            },
          }
        );
        const text = await res.text();
        return {
          content: [{ type: "text", text }],
        };
      }
    );

    // Calculator tool with multiple operations
    this.server.tool(
      "calculate",
      {
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      },
      async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot divide by zero",
                  },
                ],
              };
            result = a / b;
            break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-ignore
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      // @ts-ignore
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
