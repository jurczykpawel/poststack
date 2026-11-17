// Default D2 roles from tsa-design-system/tokens/brand-tsa.css and roles.css.
export const publicStyles = `
@font-face{font-family:Geologica;font-style:normal;font-weight:500 800;font-display:swap;src:url(/static/public-site/geologica-var.woff2) format('woff2')}

@font-face{font-family:'Source Sans 3';font-style:normal;font-weight:400 700;font-display:swap;src:url(/static/public-site/source-sans-3-var.woff2) format('woff2')}

@font-face{font-family:'Source Code Pro';font-style:normal;font-weight:400 600;font-display:swap;src:url(/static/public-site/source-code-pro-var.woff2) format('woff2')}

@font-face{font-family:'Geologica fallback';src:local(Arial);size-adjust:104%;ascent-override:92%;descent-override:24%;line-gap-override:0%}

@font-face{font-family:'Source Sans fallback';src:local(Arial);size-adjust:91%;ascent-override:108%;descent-override:30%;line-gap-override:0%}

:root{--site-bg:#F5F5F0;--site-band:#E9E8E1;--site-layer:#FBFBF8;--site-layer-2:#EFEEE8;--site-ink:#0E0E12;--site-text:#3A3A44;--site-muted:#55556A;--site-line:#D9D8D0;--site-edge:#77778E;--site-accent:#2A5BC2;--site-soft:rgba(42,91,194,.09);--site-cta:#F59E0B;--site-cta-hover:#FBBF24;--site-on-cta:#0E0E12;--site-display:Geologica,'Geologica fallback',sans-serif;--site-body:'Source Sans 3','Source Sans fallback',sans-serif;--site-mono:'Source Code Pro',monospace;--site-radius:14px;--site-control:8px;--site-gutter:clamp(20px,4vw,48px);--site-max:1280px;--site-weight:650;--site-leading:1.6;--site-space:clamp(64px,7vw,112px);--site-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 10px 22px -10px rgba(180,107,0,.5),0 2px 4px -1px rgba(14,14,18,.14);color-scheme:light}

:root[data-theme=dark]{--site-bg:#0E0E12;--site-band:#141418;--site-layer:#1A1A20;--site-layer-2:#18181E;--site-ink:#F5F5F0;--site-text:#C4C2BC;--site-muted:#8888A0;--site-line:rgba(255,255,255,.10);--site-edge:#8888A0;--site-accent:#5B8DEF;--site-soft:rgba(91,141,239,.10);--site-weight:600;--site-leading:1.66;color-scheme:dark}

@media(prefers-color-scheme:dark){:root[data-theme=auto]{--site-bg:#0E0E12;--site-band:#141418;--site-layer:#1A1A20;--site-layer-2:#18181E;--site-ink:#F5F5F0;--site-text:#C4C2BC;--site-muted:#8888A0;--site-line:rgba(255,255,255,.10);--site-edge:#8888A0;--site-accent:#5B8DEF;--site-soft:rgba(91,141,239,.10);--site-weight:600;--site-leading:1.66;color-scheme:dark}

}

[hidden]{display:none!important}

*{box-sizing:border-box}
html{scroll-padding-top:24px}
body{margin:0;background:var(--site-bg);color:var(--site-text);font-family:var(--site-body);font-size:clamp(1.0625rem,1rem + .25vw,1.1875rem);line-height:var(--site-leading);overflow-wrap:anywhere}

a{color:var(--site-accent);text-underline-offset:.24em}
a:hover{text-decoration-thickness:2px}
a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible{outline:2px solid var(--site-accent);outline-offset:4px;border-radius:4px}
button,select{font:inherit}
button,summary,select{cursor:pointer}

h1,h2,h3,strong{color:var(--site-ink)}
h1,h2,h3{font-family:var(--site-display);font-weight:var(--site-weight);line-height:1.08;text-wrap:balance}
h1{font-size:clamp(2.5rem,1.6rem + 3.6vw,4.5rem);letter-spacing:-.028em;margin:16px 0 24px;max-width:19ch;color:var(--site-accent)}
h2{font-size:clamp(1.75rem,1.2rem + 1.8vw,2.75rem);letter-spacing:-.022em;margin:0 0 24px}
h3{font-size:clamp(1.3125rem,1.15rem + .7vw,1.75rem);margin:0 0 16px}
p{margin:0 0 20px;max-width:66ch;text-wrap:pretty}
figure{margin:0}
figcaption{font-size:.9375rem;color:var(--site-muted);line-height:1.5}

.shell{max-width:var(--site-max);margin:auto;padding-inline:var(--site-gutter)}
.skip{position:absolute;top:-100px;left:20px;padding:12px 20px;z-index:20;background:var(--site-layer)}
.skip:focus{top:12px}
.site-header{border-bottom:1px solid var(--site-line)}
.masthead{min-height:88px;display:flex;align-items:center;gap:24px}
.identity{display:flex;align-items:center;gap:12px;margin-right:auto;color:var(--site-ink);font-family:var(--site-display);font-weight:600;font-size:1.125rem;text-decoration:none;min-height:44px}
.identity img{flex-shrink:0}
.brand-glyph,.slashes{color:var(--site-accent);font-family:var(--site-mono);font-weight:600}
.brand-glyph{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--site-edge);border-radius:var(--site-control)}

.primary-nav{display:flex;gap:24px}
.primary-nav a,.site-menu a{color:var(--site-text);text-decoration:none;font-size:1rem;display:flex;align-items:center;min-height:44px}
.primary-nav a[aria-current=page],.site-menu a[aria-current=page]{color:var(--site-accent);text-decoration:underline}
.site-menu{position:relative}
.site-menu summary{font-size:1rem;min-height:44px;display:flex;align-items:center;gap:8px;list-style:none;color:var(--site-ink)}
.site-menu summary::after{content:'+';font-family:var(--site-mono)}
.site-menu[open] summary::after{content:'−'}
.site-menu summary::-webkit-details-marker{display:none}
.site-menu nav{position:absolute;right:0;top:56px;z-index:10;display:grid;min-width:230px;padding:16px 24px;border:1px solid var(--site-edge);background:var(--site-layer);border-radius:var(--site-radius)}

.app-link{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 20px;border-radius:var(--site-control);background:var(--site-cta);color:var(--site-on-cta);font-size:1rem;font-weight:700;text-decoration:none;white-space:nowrap}
.app-link:hover{background:var(--site-cta-hover)}
.app-link:active{transform:scale(.97)}
.masthead .app-link{box-shadow:none}
.hero .app-link,.finale .app-link{box-shadow:var(--site-shadow)}
.eyebrow,.micro-label{font-family:var(--site-mono);font-size:.8125rem;letter-spacing:.02em;color:var(--site-accent)}
.eyebrow{margin:0 0 16px}
.eyebrow::before{content:'// ';font-weight:600}
.hero{padding-block:var(--site-space);display:grid;grid-template-columns:1.15fr 1fr;gap:48px;align-items:center}
.hero .lead{max-width:39ch;font-size:clamp(1.1875rem,1.08rem + .45vw,1.4375rem);margin-bottom:32px}
.hero h1{max-width:16ch}
.page-heading{padding-block:var(--site-space) 48px}
.page-heading h1{max-width:22ch}
.page-heading .eyebrow{margin-bottom:16px}
.page-content{padding-bottom:var(--site-space)}
.page-content>.lead{max-width:62ch;font-size:1.4375rem;margin-bottom:48px}
.page-content>section{padding-block:48px;border-top:1px solid var(--site-line)}
.page-content>section:last-child{padding-bottom:0}

.workspace-illustration{min-width:0;border:1px solid var(--site-edge);border-radius:var(--site-radius);background:var(--site-layer);transform:rotate(-1deg)}
.workspace-top{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--site-line);font-size:.9375rem;color:var(--site-ink)}
.workspace-dot{margin-left:auto;width:8px;height:8px;background:var(--site-accent);border-radius:50%}
.workspace-body{padding:24px}
.workspace-tabs{display:flex;gap:24px;font-size:.9375rem;margin-bottom:24px;border-bottom:1px solid var(--site-line)}
.workspace-tabs>*{padding-bottom:12px}
.workspace-tabs strong{border-bottom:2px solid var(--site-accent)}
.compose-example{display:grid;grid-template-columns:.75fr 1fr;gap:24px;align-items:center}
.media-art{aspect-ratio:3/4;position:relative;overflow:hidden;background:var(--site-soft);border-radius:var(--site-control);border:1px solid var(--site-line)}
.media-art span,.media-art i{position:absolute;border:1px solid var(--site-accent);border-radius:50%;width:160%;aspect-ratio:1;left:-30%;top:10%}
.media-art i{top:34%}
.media-art b{position:absolute;left:16px;bottom:24px;font-family:var(--site-display);font-size:clamp(1.5rem,2.3vw,2rem);line-height:1.1;color:var(--site-accent);letter-spacing:-.028em}
.compose-copy{min-width:0}
.compose-copy>strong{font-family:var(--site-display);font-size:1.25rem;line-height:1.3;display:block;margin:8px 0 12px}
.compose-copy p{font-size:1rem}
.sample-field,.sample-check{display:block;font-size:.8125rem;padding:12px;border:1px solid var(--site-edge);border-radius:var(--site-control);margin-top:12px}
.sample-check{border:0;padding:0;color:var(--site-accent)}
.queue-example{margin-top:24px;padding-top:20px;border-top:1px solid var(--site-line);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.queue-example>div{margin-right:auto}
.queue-example strong{display:block;font-size:.9375rem}
.status{border:1px solid var(--site-edge);border-radius:999px;padding:4px 10px;font-size:.8125rem;color:var(--site-text)}
.workspace-illustration figcaption{padding:0 24px 20px}
.feature-story{display:grid;grid-template-columns:1fr 1fr;gap:clamp(32px,7vw,96px);align-items:center}
.page-content>.feature-story{padding-block:var(--site-space)}
.feature-story h2{max-width:19ch}
.feature-story p{max-width:51ch}
.feature-story a,.access-note a{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
.capture{max-width:480px;width:100%;justify-self:center;border:1px solid var(--site-edge);border-radius:var(--site-radius);overflow:hidden;background:var(--site-layer)}
.capture-label{padding:16px 24px;color:var(--site-ink);font: .8125rem var(--site-mono)}
.capture img{display:block;width:100%;height:auto}
.capture figcaption{padding:16px 24px}
.delivery-illustration{padding:32px;background:var(--site-layer);border:1px solid var(--site-line);border-radius:var(--site-radius)}
.delivery-row{display:flex;gap:20px;align-items:center;padding:24px 0;border-bottom:1px solid var(--site-line)}
.delivery-row:last-of-type{border:0}
.delivery-symbol{width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--site-edge);border-radius:var(--site-control);color:var(--site-accent);font-size:1.5rem}
.delivery-row strong,.delivery-row div>span{display:block}
.delivery-row div>span{font-size:.9375rem}
.delivery-illustration figcaption{margin-top:12px}

.access-note{display:grid;grid-template-columns:1fr 1.3fr;gap:16px 48px}
.access-note h2{font-size:1.75rem}
.access-note a{grid-column:2}
.finale{padding-block:var(--site-space);background:var(--site-band);border-block:1px solid var(--site-line)}
.finale .shell{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center}
.finale h2{font-size:clamp(2.5rem,1.4rem + 3vw,4rem);max-width:16ch}
.finale p{margin-bottom:24px}
.process-illustration{list-style:none;margin:0 0 64px;padding:0;display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--site-edge);border-radius:var(--site-radius);background:var(--site-layer)}
.process-illustration li{padding:24px;border-right:1px solid var(--site-line)}
.process-illustration li:last-child{border:0}
.process-illustration span{font: .8125rem var(--site-mono);color:var(--site-accent);display:block;margin-bottom:24px}
.process-illustration strong{font-family:var(--site-display);display:block}
.process-illustration p{font-size:1rem;margin:12px 0 0}
.integration-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:32px 0}
.integration{padding:24px;border:1px solid var(--site-line);border-radius:var(--site-radius);background:var(--site-layer)}
.integration h3{font-size:1.3125rem}
.integration p{font-size:1rem;margin-bottom:12px}
.scopes{font-family:var(--site-mono);font-size:.85em}
.document{max-width:960px}
.document .page-content>section{max-width:760px}
.document h2{font-size:1.75rem;line-height:1.2;margin-top:40px}
.document section>h2:first-child{margin-top:0}
.document .page-heading{border-bottom:0}
.document .page-content>.lead{margin-bottom:40px}
.document .page-content>section{padding-block:40px}
.contact-email{color:var(--site-accent);border:0;background:transparent;padding:8px 0;min-height:44px;text-decoration:underline;text-underline-offset:.24em}
.related{padding:24px 0;border-top:1px solid var(--site-line);display:flex;flex-wrap:wrap;gap:8px 24px}
.related strong{width:100%;font-size:1rem}
.related a{font-size:1rem;min-height:44px;display:flex;align-items:center}

.site-footer{background:var(--site-band);padding-block:64px 24px}
.footer-grid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:32px}
.footer-grid strong{font-size:1.125rem}
.footer-grid p{font-size:1rem;margin-top:12px;max-width:28ch}
.footer-group{display:flex;flex-direction:column}
.footer-group strong{font: .8125rem var(--site-mono);color:var(--site-muted);margin-bottom:12px}
.footer-group a{font-size:1rem;min-height:44px;display:flex;align-items:center;text-decoration:none;color:var(--site-text)}
.footer-group a:hover{text-decoration:underline}
.footer-bottom{margin-top:40px;border-top:1px solid var(--site-line);padding-top:24px;display:flex;justify-content:space-between;align-items:center;gap:24px;font-size:.9375rem}
.footer-bottom a{display:inline-flex;align-items:center;min-height:44px}
.theme-control{display:flex;align-items:center;gap:12px}
.theme-control select{background:var(--site-layer);color:var(--site-ink);border:1px solid var(--site-edge);border-radius:var(--site-control);min-height:44px;padding:8px 12px}

@media(min-width:980px){.document{padding-right:160px}
}

@media(max-width:1139px){.primary-nav{display:none}
.hero{gap:32px}
}

@media(max-width:979px){.hero{grid-template-columns:1fr;max-width:760px}
.hero h1{max-width:19ch}
.workspace-illustration{transform:none}
.feature-story{gap:32px}
.footer-grid{grid-template-columns:1.4fr 1fr}
.document{max-width:800px}
}

@media(max-width:650px){.masthead{min-height:80px;gap:16px;flex-wrap:wrap}
.identity{font-size:1rem;gap:8px}
.masthead .app-link{padding:10px 12px;font-size:.9375rem;min-height:44px}
.masthead>.app-link{order:2}
.site-menu{order:3;width:100%;border-top:1px solid var(--site-line)}
.site-menu summary{justify-content:space-between}
.site-menu nav{position:static;margin-bottom:16px;grid-template-columns:1fr 1fr;padding:12px 16px;min-width:0}
.hero{padding-block:48px 64px;gap:40px}
.hero h1{max-width:13ch}
.hero .lead{font-size:1.25rem}
.workspace-body{padding:16px}
.workspace-top{padding:16px}
.compose-example{gap:16px}
.compose-copy>strong{font-size:1rem}
.compose-copy p{font-size:.9375rem}
.sample-field{padding:8px;font-size:.75rem}
.workspace-tabs{gap:24px}
.media-art b{font-size:1.5rem;left:12px}
.workspace-illustration figcaption{padding:0 16px 16px}
.micro-label{font-size:.75rem}
.feature-story,.access-note,.finale .shell{grid-template-columns:1fr}
.feature-story h2{max-width:20ch}
.page-content>.feature-story{padding-block:48px}
.access-note a{grid-column:auto}
.delivery-illustration{padding:24px}
.finale .shell{gap:24px}
.process-illustration{grid-template-columns:1fr 1fr;margin-bottom:40px}
.process-illustration li{padding:20px;border-bottom:1px solid var(--site-line)}
.process-illustration li:nth-child(2){border-right:0}
.process-illustration li:nth-child(3){border-bottom:0}
.integration-grid{grid-template-columns:1fr}
.footer-grid{grid-template-columns:1fr 1fr;gap:32px 20px}
.footer-identity{grid-column:1/-1}
.footer-bottom{align-items:flex-start;flex-direction:column;gap:16px}
.page-heading{padding-block:48px 24px}
.page-content>.lead{font-size:1.25rem}
.document .page-content>section{padding-block:32px}
}

@media(max-height:700px) and (min-width:980px){.hero h1{font-size:clamp(2.125rem,1.5rem + 2.5vw,3.75rem)}
.hero{padding-block:48px}
}


.content-illustration{padding:32px;background:var(--site-layer-2);border:1px solid var(--site-line);border-radius:var(--site-radius)}
.content-sample{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:center;margin:24px 0}
.content-sample h3{font-size:1.5rem;margin:24px 0 16px}
.content-sample p{font-size:1rem;margin-top:8px}.content-sample strong{font-size:1rem}
.caption-lines{margin-bottom:24px}.caption-lines i{display:block;height:8px;background:var(--site-line);margin-bottom:12px;border-radius:4px}.caption-lines i:last-child{width:65%}
.capture{max-width:480px;width:100%}.capture-options{aspect-ratio:658/410;overflow:hidden;background:var(--site-band)}
.capture-consent{aspect-ratio:658/105;overflow:hidden;background:var(--site-band)}.capture-consent img{transform:translateY(calc(-100% + 100% * 105 / 1066))}
.capture-label{border-block:1px solid var(--site-line)}
.feature-overview{display:grid;grid-template-columns:.85fr 1.15fr;gap:64px;align-items:center;margin-bottom:64px}
.feature-overview .lead{font-size:1.4375rem;margin-bottom:40px}.feature-overview a{display:inline-flex;align-items:center;min-height:44px}
@media(min-width:980px){.capture-story>div{order:2}.capture-story>.capture{order:1}}
@media(max-width:979px){.feature-overview{grid-template-columns:1fr;gap:32px}.feature-overview .workspace-illustration{max-width:760px}}
@media(max-width:650px){.content-illustration{padding:24px}.content-sample{gap:16px}.content-sample h3{font-size:1.125rem}.content-sample .media-art{min-height:180px}.capture{max-width:100%}.workspace-illustration .queue-example>div{width:100%}.queue-example{gap:8px}.hero h1{max-width:16ch}}

@media(prefers-reduced-motion:no-preference){.app-link{transition:transform 120ms cubic-bezier(.16,1,.3,1)}
.workspace-tabs strong{transition:transform 240ms cubic-bezier(.16,1,.3,1)}
.workspace-illustration:hover .workspace-tabs strong{transform:translateY(-2px)}
}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}
.app-link:active{transform:none}
}

`;
