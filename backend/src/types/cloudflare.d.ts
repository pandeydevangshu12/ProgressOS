declare module 'cloudflare:node' {
  export function httpServerHandler(options: { port: number } | number | any): {
    fetch(request: Request, env: any, ctx: any): Promise<Response> | Response;
  };
}
