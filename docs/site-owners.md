# What a site owner must do to allow iframing

This page is for the owner of a **website that a platform wants to embed** in an iframe. If a site shows up blank, or says it "refused to connect", when it is added to the mainframe as a Link, the fix is on the site's side. Send the owner this page.

Browsers decide whether a page can be framed from the **response headers on that page**. The embedding site has no say. So the owner changes headers or settings on their side.

## 1. Remove or loosen the blocking headers

Two headers control framing. If either blocks the embedder, the page won't load.

**`Content-Security-Policy: frame-ancestors`** is the modern one. It overrides `X-Frame-Options` in current browsers.

| Goal | Header value |
|---|---|
| Allow everyone | Remove the directive, or `frame-ancestors *` |
| Allow specific sites | `frame-ancestors 'self' https://partner.com https://*.partner.com` |
| Allow only itself | `frame-ancestors 'self'` |
| Block all | `frame-ancestors 'none'` |

**`X-Frame-Options`** is the legacy header. Its values are `DENY`, `SAMEORIGIN` and the obsolete `ALLOW-FROM`.

- Remove it for everyone-allowed framing. Browsers ignore `ALLOW-FROM` today, so it can't allow a specific site.
- To allow specific sites, drop `X-Frame-Options` and use `frame-ancestors`.
- Don't set both with conflicting rules.

## 2. Find where the header is actually set

It is often set in several layers, and **all** of them must allow framing:

- **Web server:**
  - nginx: `add_header X-Frame-Options ...;`
  - Apache: `Header always set X-Frame-Options ...`
  - IIS: `web.config` custom headers
- **Reverse proxy, CDN or WAF:** Cloudflare, Akamai, CloudFront response-header policies, Azure Front Door, Zscaler and similar often inject these headers.
- **App framework:**
  - Next.js: `headers()` in `next.config`
  - Express: `helmet()` sets `frameguard` by default
  - Django: `XFrameOptionsMiddleware` and `X_FRAME_OPTIONS = 'DENY'`
  - Rails: `config.action_dispatch.default_headers`
  - Spring Security: `headers().frameOptions()`
  - ASP.NET: the `X-Frame-Options` middleware
- **HTML `<meta http-equiv>` tags:** `frame-ancestors` is **ignored** in a meta tag. It only works as an HTTP header.

Next.js example, allowing one partner:

```js
async headers() {
  return [{
    source: '/embed/:path*',
    headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://partner.com" }],
  }];
}
```

## 3. Scope it narrowly

Don't open the whole site. Put the permissive headers on a dedicated route such as `/embed/*` or `/widget/*`. Keep `DENY` or `'self'` everywhere else, especially on login, admin and payment pages.

## 4. Handle things that break inside iframes

Framing is allowed once the headers are fixed, but these can still fail:

- **Third-party cookies:** Cookies set inside an iframe on another domain need `SameSite=None; Secure`. Chrome, Safari and Firefox increasingly block them regardless. Session logins often break.
- **Storage partitioning:** `localStorage` and cookies are partitioned per top-level site, so users may appear logged out.
- **Frame-busting JavaScript:** Code like `if (top !== self) top.location = self.location` breaks out of the frame. Remove it.
- **COEP/COOP:** `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy` can block embedding in some setups.
- **Embedded sub-resources:** If the page itself loads content from another origin that blocks framing, that part fails.

## 5. Security measures if you open it up

- **Clickjacking:** This is the risk `X-Frame-Options` exists to stop. Only allow framing on pages with no sensitive actions, or use an allow-list rather than `*`.
- **Embedder-side `sandbox`:** The embedding site can restrict the frame, for example `<iframe sandbox="allow-scripts allow-same-origin">`. Know that the owner can't force this.
- **`postMessage`:** If the embed talks to its parent, always check `event.origin`.
- **Token-based access:** Prefer short-lived signed URLs over relying on cookies.

## 6. Platform-specific shortcuts

Many platforms already provide an embed mode, so the owner usually only needs to enable it:

- **YouTube or Vimeo:** Use the `/embed/` URL, not the watch page.
- **Google Maps:** Use the Embed API or the "Share → Embed a map" URL.
- **Power BI, Tableau, Looker:** Turn on embedding and add the allowed domains in admin settings.
- **SharePoint:** Set the allowed embed domains in the tenant or site settings. Other SaaS tools have similar admin options.
- **Salesforce:** Add the domain under Session Settings → Clickjack protection or CSP Trusted Sites.

## 7. Verify after the change

```bash
curl -sI https://their-site.example/embed/page | grep -iE 'x-frame-options|content-security-policy'
```

Check that:

- `X-Frame-Options` is absent or doesn't conflict with `frame-ancestors`.
- `frame-ancestors` lists your embedder's exact origin, with scheme and port, or is absent.
- You tested in a real browser. The console shows `Refused to display ... in a frame because it set 'X-Frame-Options'` or `Refused to frame ... frame-ancestors` if something still blocks it.

## Summary

1. Find every layer that sends `X-Frame-Options` or `frame-ancestors` (app, server, CDN, WAF).
2. Remove `X-Frame-Options` on the embeddable route and set `frame-ancestors` to the exact partner origins.
3. Limit this to dedicated embed paths.
4. Fix cookies (`SameSite=None; Secure`) and remove frame-busting scripts.
5. Re-test with `curl -I` and a real browser.
