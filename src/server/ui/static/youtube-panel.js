// YouTube choices for Compose. Field names in options() are the API's (POST /api/v1/posts).
window.psYouTubePanel = function () {
  var CLOCK = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;
  var LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
  function seconds(v) {
    var m = CLOCK.exec(String(v || "").trim());
    return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  }
  return {
    privacy: "private", categoryId: "", tags: "", kids: "", ai: "", license: "", embeddable: true, stats: true, notify: true,
    language: "", recordingDate: "", chapters: [], localizations: [],
    addChapter() { this.chapters.push({ start: this.chapters.length ? "" : "00:00", title: "" }); },
    removeChapter(i) { this.chapters.splice(i, 1); },
    sortChapters() {
      this.chapters.sort(function (a, b) { return (seconds(a.start) === null ? 1e9 : seconds(a.start)) - (seconds(b.start) === null ? 1e9 : seconds(b.start)); });
    },
    addLocalization() { this.localizations.push({ lang: "", title: "", description: "" }); },
    removeLocalization(i) { this.localizations.splice(i, 1); },
    get tagList() { return this.tags.split(",").map(function (t) { return t.trim(); }).filter(Boolean); },
    get tagsError() { return this.tagList.join("").length > 500 ? "Tags may be at most 500 characters in total." : ""; },
    get chapterError() {
      var c = this.chapters;
      if (!c.length) return "";
      if (c.length < 3) return "YouTube needs at least 3 chapters.";
      for (var i = 0; i < c.length; i++) {
        if (seconds(c[i].start) === null) return "Chapter " + (i + 1) + ": use a time like 00:00 or 1:02:03.";
        if (!c[i].title.trim() || /[<>]/.test(c[i].title)) return "Chapter " + (i + 1) + ": give it a title without < or >.";
      }
      if (seconds(c[0].start) !== 0) return "The first chapter must start at 00:00.";
      for (var j = 1; j < c.length; j++) {
        if (seconds(c[j].start) - seconds(c[j - 1].start) < 10) return "Chapter " + (j + 1) + " must start at least 10 seconds after the previous one.";
      }
      return "";
    },
    get languageError() { return this.language && !LANG.test(this.language) ? "Use a language code like pl, en or pt-BR." : ""; },
    get localizationError() {
      if (!this.localizations.length) return "";
      if (!this.language) return "Set the video language before adding translations.";
      for (var i = 0; i < this.localizations.length; i++) {
        var l = this.localizations[i];
        if (!LANG.test(l.lang) || !l.title.trim()) return "Translation " + (i + 1) + ": needs a language code and a title.";
      }
      return "";
    },
    valid(requireKids) {
      return !(this.tagsError || this.chapterError || this.languageError || this.localizationError || (requireKids && this.kids === ""));
    },
    options() {
      var o = { youtubePrivacy: this.privacy, youtubeEmbeddable: this.embeddable, youtubePublicStatsViewable: this.stats, youtubeNotifySubscribers: this.notify };
      if (this.categoryId) o.youtubeCategoryId = this.categoryId;
      if (this.tagList.length) o.youtubeTags = this.tagList;
      if (this.kids !== "") o.youtubeMadeForKids = this.kids === "yes";
      if (this.ai) o.aiDisclosure = this.ai;
      if (this.license) o.youtubeLicense = this.license;
      if (this.language) o.youtubeDefaultLanguage = this.language;
      if (this.recordingDate) o.youtubeRecordingDate = new Date(this.recordingDate + "T00:00:00Z").toISOString();
      if (this.chapters.length) o.youtubeChapters = this.chapters.map(function (c) { return { start: c.start.trim(), title: c.title.trim() }; });
      if (this.localizations.length) {
        var loc = {};
        this.localizations.forEach(function (l) { loc[l.lang] = { title: l.title.trim(), description: l.description.trim() || undefined }; });
        o.youtubeLocalizations = loc;
      }
      return o;
    },
  };
};
