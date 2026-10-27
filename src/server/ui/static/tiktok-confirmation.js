window.psTikTokConfirmation = function () {
  var data = JSON.parse(document.getElementById("ps-tiktok-confirm-data").textContent);
  var tt = window.psTikTokPanel(data.creator, data.channelId);
  tt.mode = data.mode;
  tt.videoDurationSec = data.duration;
  return {
    tt: tt, mediaUrl: data.mediaUrl, coverUrl: "", sel: { tiktok: { override: data.caption } }, publishMode: "now",
    isOn() { return true; },
    captionFor() { return this.sel.tiktok.override; },
    tiktokScheduleText() { return ""; },
    tiktokConsentKey() { return JSON.stringify([this.tt.channelId, this.mediaUrl, this.captionFor(), this.tt.options(), this.tt.disclosure]); },
    get ready() { return this.tt.valid && this.tt.consent && this.tt.consentKey === this.tiktokConsentKey(); },
    prepare(event) {
      if (!this.ready) { event.preventDefault(); return; }
      this.$refs.payload.value = JSON.stringify(Object.assign({}, this.tt.options(), { caption: this.captionFor(), consent: this.tt.consent, disclosure: this.tt.disclosure }));
    },
  };
};
