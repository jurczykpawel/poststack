// Dark-theme stylesheet for the server-rendered dashboard. Class-based so the
// HTML templates stay readable (no inline-style soup).
export const CSS = `
:root{--background:#0f0f0f;--foreground:#f5f5f5;--muted:#1a1a1a;--muted-foreground:#888;--border:#2a2a2a;--primary:#6366f1;--primary-foreground:#fff;--destructive:#ef4444;--success:#22c55e;--radius:6px}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--background);color:var(--foreground);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--primary);text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:1.25rem;font-weight:700;margin-bottom:.25rem}
h2{font-size:1rem;font-weight:600;margin-bottom:.75rem}
.muted{color:var(--muted-foreground);font-size:.875rem}
.label{display:block;margin-bottom:.25rem;color:var(--muted-foreground);font-size:.8rem}
.input,.textarea,select.input{width:100%;padding:.5rem .75rem;background:var(--muted);border:1px solid var(--border);border-radius:var(--radius);color:var(--foreground);font-size:.875rem;font-family:inherit}
.textarea{resize:vertical}
.btn{padding:.5rem 1rem;border-radius:var(--radius);font-weight:600;font-size:.875rem;cursor:pointer;border:1px solid var(--border);background:var(--muted);color:var(--foreground)}
.btn:hover{filter:brightness(1.15)}
.btn-primary{background:var(--primary);color:var(--primary-foreground);border:none}
.btn-ghost{background:none;border:none;color:var(--muted-foreground);text-align:left;width:100%}
.btn-danger{background:none;border:1px solid var(--destructive);color:var(--destructive)}
.btn-sm{padding:.25rem .75rem;font-size:.75rem;font-weight:500}
.error{color:var(--destructive);font-size:.8rem}
.notice{padding:.75rem 1rem;border-radius:var(--radius);margin-bottom:1rem;font-size:.875rem}
.notice-ok{background:var(--primary);color:var(--primary-foreground)}
.notice-err{background:var(--destructive);color:#fff}
.card{padding:1rem;background:var(--muted);border:1px solid var(--border);border-radius:var(--radius)}
.badge{display:inline-block;background:var(--primary);color:var(--primary-foreground);border-radius:99px;padding:0 .4rem;font-size:.7rem}
.page{padding:2rem;max-width:760px}
.row{display:flex;gap:.5rem;align-items:center}
.stack{display:flex;flex-direction:column;gap:.75rem}
/* auth */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.auth-box{width:100%;max-width:360px}
.auth-head{margin-bottom:2rem;text-align:center}
/* shell */
.app{display:flex;min-height:100vh}
.sidebar{width:200px;background:var(--muted);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:1rem 0;flex-shrink:0}
.brand{padding:0 1rem 1rem;border-bottom:1px solid var(--border);margin-bottom:.5rem;font-weight:700;font-size:1rem}
.nav{display:flex;flex-direction:column;gap:.125rem;padding:0 .5rem}
.nav-link{padding:.5rem .75rem;border-radius:var(--radius);color:var(--foreground);font-size:.875rem}
.nav-link:hover{background:var(--background);text-decoration:none}
.nav-link.active{background:var(--background)}
.signout{margin-top:auto;padding:0 .5rem}
.main{flex:1;overflow:auto}
/* inbox */
.inbox{display:flex;height:100vh}
.conv-list{width:280px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0}
.conv-head{padding:1rem;border-bottom:1px solid var(--border);font-weight:700;font-size:.875rem}
.conv-item{display:block;width:100%;text-align:left;padding:.75rem 1rem;border:none;border-bottom:1px solid var(--border);background:transparent;cursor:pointer;color:var(--foreground)}
.conv-item:hover,.conv-item.active{background:var(--muted)}
.conv-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:.2rem}
.conv-name{font-weight:400;font-size:.875rem}
.conv-name.unread{font-weight:700}
.conv-time{font-size:.7rem;color:var(--muted-foreground)}
.conv-preview{font-size:.75rem;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thread{flex:1;display:flex;flex-direction:column;height:100vh}
.thread-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted-foreground);font-size:.875rem}
.thread-head{padding:.75rem 1rem;border-bottom:1px solid var(--border);font-weight:600;font-size:.875rem}
.thread-msgs{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.5rem}
.msg{display:flex}
.msg-out{justify-content:flex-end}
.msg-in{justify-content:flex-start}
.bubble{max-width:70%;padding:.5rem .75rem;border-radius:var(--radius);font-size:.875rem;background:var(--muted)}
.msg-out .bubble{background:var(--primary);color:var(--primary-foreground)}
.reply-bar{padding:.75rem 1rem;border-top:1px solid var(--border);display:flex;gap:.5rem}
.reply-bar .textarea{flex:1}
/* list rows */
.list{display:flex;flex-direction:column;gap:.5rem}
.list-row{display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;background:var(--muted);border:1px solid var(--border);border-radius:var(--radius)}
.avatar{width:36px;height:36px;border-radius:50%;flex-shrink:0;object-fit:cover}
.grow{flex:1}
.mono{font-family:monospace}
.section{margin-top:2rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--border);font-size:.8125rem}
th{color:var(--muted-foreground);font-weight:500}
`;
