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
