import { NextRequest, NextResponse } from "next/server";

/**
 * Redirect page with Open Graph meta tags.
 * X's link unfurler scrapes this page and generates a proper website card.
 * Real users get redirected to the actual destination URL.
 *
 * Usage: /r?u={encodedUrl}&t={title}&img={imageUrl}
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const destUrl = url.searchParams.get("u") || "https://x.com";
  const title = url.searchParams.get("t") || "Watch more";
  const image = url.searchParams.get("img") || "";

  const ua = req.headers.get("user-agent") || "";
  const isCrawler = /Twitterbot|facebookexternalhit|Slackbot|Discordbot|Telegrambot|Googlebot|Bingbot/i.test(ua);

  if (isCrawler) {
    const safeTitle = title.replace(/"/g, "&quot;").replace(/</g, "&lt;").slice(0, 100);
    const safeUrl = destUrl.replace(/"/g, "&quot;");
    const safeImg = image.replace(/"/g, "&quot;");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>${safeTitle}</title>
<meta property="og:title" content="${safeTitle}"/>
<meta property="og:description" content="Click to watch now"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${safeUrl}"/>
${safeImg ? `<meta property="og:image" content="${safeImg}"/>` : ""}
<meta property="og:site_name" content="Watch More"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${safeTitle}"/>
<meta name="twitter:description" content="Click to watch now"/>
${safeImg ? `<meta name="twitter:image" content="${safeImg}"/>` : ""}
</head>
<body>
<p>${safeTitle}</p>
<p><a href="${safeUrl}">Continue</a></p>
<script>window.location.href = "${safeUrl}";</script>
</body>
</html>`;
    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return NextResponse.redirect(destUrl, 302);
}
