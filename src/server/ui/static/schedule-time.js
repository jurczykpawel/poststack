/* Shared by Compose and the Content publishing panel; Date uses the browser's timezone. */
window.psScheduleTime = function (local) {
  var date = new Date(local);
  if (!local || !Number.isFinite(date.getTime())) return { iso: "", notice: "" };
  function wall(d) {
    function pad(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function offset(d) {
    var minutes = -d.getTimezoneOffset();
    return "UTC" + (minutes >= 0 ? "+" : "-") + String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0") + ":" + String(Math.abs(minutes) % 60).padStart(2, "0");
  }
  var resolved = wall(date);
  var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var notice = "";
  if (resolved !== local) {
    notice = "This local time does not exist in " + zone + ". It will be shifted to " + resolved.replace("T", " ") + " (" + offset(date) + ").";
  } else {
    // Nearby offsets also cover half-hour changes, without assuming a one-hour DST shift.
    [-1, 1].some(function (direction) {
      var nearby = new Date(date.getTime() + direction * 86400000);
      var delta = nearby.getTimezoneOffset() - date.getTimezoneOffset();
      var alternative = new Date(date.getTime() + delta * 60000);
      if (delta && wall(alternative) === local) {
        notice = "This local time occurs twice in " + zone + ". The " + (date < alternative ? "earlier" : "later") + " occurrence (" + offset(date) + ") will be used.";
        return true;
      }
      return false;
    });
  }
  return { iso: date.toISOString(), notice: notice };
};

window.psReschedule = function () {
  return {
    local: "",
    get minLocal() {
      var d = new Date(Date.now() + 60000);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    },
    get iso() { return window.psScheduleTime(this.local).iso; },
    get notice() { return window.psScheduleTime(this.local).notice; },
    get valid() { return !!this.iso && new Date(this.iso).getTime() > Date.now(); },
    get preview() {
      return this.iso ? new Date(this.iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) + " · " + Intl.DateTimeFormat().resolvedOptions().timeZone : "";
    },
    get confirmation() { return "Move this post to " + this.preview + "? It goes out automatically with its saved settings."; },
  };
};

(function () {
  function localize(root) {
    var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    root.querySelectorAll("time[data-local-time]").forEach(function (el) {
      var date = new Date(el.getAttribute("datetime"));
      if (!Number.isFinite(date.getTime())) return;
      el.textContent = date.toLocaleString("en-GB", {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
      }) + " · " + zone;
    });
  }
  // Server-rendered calendar days (Queue) need the zone; a list rendered for another zone is fetched again once.
  function syncZone() {
    var zone = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if ((document.cookie || "").split("; ").indexOf("ps_tz=" + zone) >= 0) return;
    document.cookie = "ps_tz=" + zone + "; path=/; max-age=31536000; samesite=lax";
    var view = document.querySelector && document.querySelector("[data-view-tz]");
    if (!view || encodeURIComponent(view.getAttribute("data-view-tz")) === zone) return;
    view.setAttribute("data-view-tz", decodeURIComponent(zone));
    if (window.htmx && document.getElementById("data-list")) window.htmx.ajax("GET", location.href, { target: "#data-list", select: "#data-list", swap: "outerHTML" });
    else location.reload();
  }
  function start() { localize(document); syncZone(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  document.addEventListener("htmx:load", function (event) { localize(event.target); });
})();
