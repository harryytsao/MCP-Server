import Swagger from "swagger-client";
import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import openApiSpec from "./v1.json";

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Dynamic OpenAPI Proxy",
    version: "1.0.0",
  });

  async init() {
    const spec = openApiSpec; // Use the imported JSON directly

    // 2) build a swagger-client to make invocation easy
    const client = await Swagger({
      spec,
    });

    // 3) iterate operations
    for (const tagName of Object.keys(client.apis)) {
      const tag = (client.apis as any)[tagName];
      for (const opId of Object.keys(tag)) {
        const operation = (tag as any)[opId] as {
          operationId?: string;
          parameters?: any[];
          requestBody?: any;
        };

        // derive a unique tool name and sanitize it
        let toolName = operation.operationId || `${tagName}_${opId}`;
        // Ensure name matches the pattern ^[a-zA-Z0-9_-]{1,64}$
        toolName = toolName
          .replace(/[^a-zA-Z0-9_-]/g, "_") // Replace invalid chars with underscore
          .substring(0, 64); // Limit to 64 chars

        // construct a Zod schema for inputs
        const paramSchemas: Record<string, z.ZodTypeAny> = {};
        (operation.parameters || []).forEach((p: any) => {
          let schema: z.ZodTypeAny = z.any();
          if (p.schema?.type === "string") schema = z.string();
          if (p.schema?.type === "number") schema = z.number();
          if (p.schema?.type === "boolean") schema = z.boolean();
          paramSchemas[p.name] = schema;
        });
        if (operation.requestBody?.content?.["application/json"]?.schema) {
          // simple handling of JSON bodies
          paramSchemas["body"] = z.any();
        }

        // register the tool
        this.server.tool(toolName, paramSchemas, async (args, extra) => {
          // 4a) call through swagger-client
          const res = await (client.apis as any)[tagName][opId]({
            ...args,
            requestBody: args.body,
          });
          // 4b) normalize the response
          const contentType = res.headers["content-type"] || "";
          const isJson = contentType.includes("application/json");
          const payload = isJson ? JSON.stringify(res.body) : res.text;
          return {
            content: [{ type: "text", text: payload }],
          };
        });
      }
    }
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
