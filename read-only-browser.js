export default async ({ page }) => {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method()) ||
      /\/(?:cart\/(?:add|update|change|clear)|checkout(?:s)?)(?:[/.]|$)/i.test(
        pathname,
      )
    ) {
      await route.abort();
      return;
    }
    await route.fallback();
  });
  await page.routeWebSocket("**/*", (socket) => socket.close());
};
