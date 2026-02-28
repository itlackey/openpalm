import { e as ensure_array_like, a as attr_class, b as stringify, c as escape_html, d as derived, h as head, f as attr } from "../../chunks/root.js";
import { b as base } from "../../chunks/server.js";
import "../../chunks/url.js";
import "@sveltejs/kit/internal/server";
import { v as version } from "../../chunks/environment.js";
import "clsx";
let toasts = [];
function getToasts() {
  return toasts;
}
function ToastContainer($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const toasts2 = derived(getToasts);
    if (toasts2().length > 0) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="toast-container" aria-live="assertive"><!--[-->`);
      const each_array = ensure_array_like(toasts2());
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let toast = each_array[$$index];
        $$renderer2.push(`<button${attr_class(`toast toast-${stringify(toast.type)}`)}>${escape_html(toast.message)}</button>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]-->`);
  });
}
function _layout($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { children } = $$props;
    head("12qhfyh", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>OpenPalm Admin</title>`);
      });
    });
    $$renderer2.push(`<nav><span class="logo"><img${attr("src", `${stringify(base)}/logo.png`)} alt="OpenPalm logo"/> OpenPalm <span class="muted" style="font-size:12px">v${escape_html(version)}</span></span> <a${attr("href", `${stringify(base)}/`)} style="text-decoration:none"><button class="nav-btn active">Dashboard</button></a> <button class="theme-toggle" aria-label="Toggle color mode">${escape_html("☀️ Light")}</button></nav> <div class="container">`);
    children($$renderer2);
    $$renderer2.push(`<!----></div> `);
    ToastContainer($$renderer2);
    $$renderer2.push(`<!---->`);
  });
}
export {
  _layout as default
};
