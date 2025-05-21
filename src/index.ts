import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import openApiSchema from "./v2.json";

// Helper type for OpenAPI path parameters
type PathParameter = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: {
    type: string;
    format?: string;
  };
};

// Helper type for OpenAPI property schema
type OpenAPIPropertySchema = {
  type?: string;
  format?: string;
  $ref?: string;
  default?: any;
  nullable?: boolean;
};

// Helper type for OpenAPI schema objects
type OpenAPISchemaObject = {
  type?: string;
  required?: string[];
  properties?: {
    [key: string]: OpenAPIPropertySchema;
  };
};

// Helper type for OpenAPI components
type OpenAPIComponents = {
  schemas: {
    [key: string]: OpenAPISchemaObject;
  };
};

// Helper to convert OpenAPI types to Zod schemas
function getZodSchemaForParameter(param: PathParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny = z.string();
  if (param.schema.type === "integer") {
    schema = z.number().int();
  } else if (param.schema.type === "number") {
    schema = z.number();
  }
  return param.required ? schema : schema.optional();
}

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Integrations",
    version: "1.0.0",
  });

  private createToolFromEndpoint(
    path: string,
    method: string,
    operation: any,
    baseUrl: string,
    organizationId: string
  ) {
    const toolName =
      operation.operationId || `${method}${path.replace(/[/{}/]/g, "_")}`;
    const parameters = operation.parameters || [];

    // Build Zod schema for parameters
    const paramSchema: Record<string, any> = {};

    // Handle path parameters
    parameters.forEach((param: PathParameter) => {
      if (param.in === "path") {
        paramSchema[param.name] = getZodSchemaForParameter(param);
      }
    });

    // Handle request body if it exists
    if (operation.requestBody?.content?.["application/json"]?.schema?.$ref) {
      const refPath = operation.requestBody.content[
        "application/json"
      ].schema.$ref
        .split("/")
        .slice(1);

      // Start with components.schemas
      const schemas = (openApiSchema.components as OpenAPIComponents).schemas;
      // Get the referenced schema
      const schemaName = refPath[refPath.length - 1];
      const referencedSchema = schemas[schemaName];

      // For GetClientRecord specifically
      if (referencedSchema.required?.includes("ClientNumber")) {
        paramSchema.ClientNumber = z.number().int();
      }

      // Add other required fields from the schema if needed
      if (referencedSchema.required && referencedSchema.properties) {
        referencedSchema.required.forEach((field: string) => {
          const prop = referencedSchema.properties?.[field];
          if (prop?.type) {
            if (prop.type === "integer") {
              paramSchema[field] = z.number().int();
            } else if (prop.type === "string") {
              paramSchema[field] = z.string();
            }
            // Add other types as needed
          }
        });
      }
    }

    // Create the tool
    this.server.tool(toolName, paramSchema, async (params) => {
      try {
        // Replace path parameters
        let finalPath = path;
        Object.entries(params).forEach(([key, value]) => {
          if (path.includes(`{${key}}`)) {
            finalPath = finalPath.replace(
              `{${key}}`,
              encodeURIComponent(String(value))
            );
          }
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: operation.responses["200"].content?.["application/json"]
            ? "application/json"
            : "text/plain",
        };

        // Add required headers from parameters
        parameters.forEach((param: PathParameter) => {
          if (param.in === "header" && param.required) {
            if (param.name === "X-Org-Id") {
              headers[param.name] = organizationId;
            }
          }
        });

        const requestInit: RequestInit = {
          method: method.toUpperCase(),
          headers,
        };

        // Add request body if needed
        if (operation.requestBody) {
          // Remove parameters that were used in the path
          const bodyParams = { ...params };
          Object.keys(bodyParams).forEach((key) => {
            if (path.includes(`{${key}}`)) {
              delete bodyParams[key];
            }
          });
          requestInit.body = JSON.stringify(bodyParams);
        }

        console.log(`Making request to: ${baseUrl}${finalPath}`, requestInit);
        const res = await fetch(`${baseUrl}${finalPath}`, requestInit);

        const body = await res.text();
        console.log(
          `${toolName} response:`,
          res.status,
          res.statusText,
          "|",
          body
        );

        if (!res.ok) {
          throw new Error(body || `HTTP error ${res.status}`);
        }

        let responseContent;
        try {
          // Try to parse as JSON if the response is JSON
          responseContent = JSON.parse(body);
        } catch {
          // If not JSON, use as plain text
          responseContent = body;
        }

        return {
          content: [{ type: "text", text: String(responseContent) }],
        };
      } catch (error: any) {
        console.error(`Error in ${toolName}:`, error);
        return {
          content: [
            {
              type: "text",
              text: `Error in ${toolName}: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  async init() {
    const baseUrl = "http://localhost:9999";
    const organizationId = "8232f2d1-91f2-4d17-9a7e-756dd5dc7544";

    // Create tools from OpenAPI schema
    Object.entries(openApiSchema.paths).forEach(
      ([path, pathItem]: [string, any]) => {
        Object.entries(pathItem).forEach(
          ([method, operation]: [string, any]) => {
            // Skip if operation is not a HTTP method
            if (!["get", "post", "put", "delete", "patch"].includes(method)) {
              return;
            }
            this.createToolFromEndpoint(
              path,
              method,
              operation,
              baseUrl,
              organizationId
            );
          }
        );
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
