// Creator-facing choices shared by Compose and confirmation screens.
window.psTikTokPanel = function (result, channelId) {
  return {
    channelId: channelId || "",
    info: result && result.status === "available" ? result.creator_info : null,
    mode: "inbox", privacy: "",
    allowComment: false, allowDuet: false, allowStitch: false,
    disclosure: false, brandYourBrand: false, brandedContent: false,
    consent: false, consentKey: "", videoDurationSec: 0,
    confirm(key, checked) { this.consentKey = key; this.consent = checked; },
    get unavailable() { return !this.info; },
    get durationExceeded() {
      return !!(this.info && this.info.max_video_post_duration_sec && this.videoDurationSec > Math.min(600, this.info.max_video_post_duration_sec));
    },
    get disclosureLabel() {
      if (!this.disclosure) return "";
      return this.brandedContent ? "Paid partnership" : this.brandYourBrand ? "Promotional content" : "";
    },
    get brandedContentDisabled() { return this.privacy === "SELF_ONLY"; },
    get privacyOptionsView() {
      var labels = { PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" };
      var branded = this.disclosure && this.brandedContent;
      return (this.info ? this.info.privacy_level_options : []).map(function (value) {
        var disabled = value === "SELF_ONLY" && branded;
        return { value: value, label: labels[value] || value, disabled: disabled,
          note: disabled ? "Branded content visibility cannot be set to private" : "" };
      });
    },
    interactionDisabled(kind) { return !this.info || this.info[kind + "_disabled"]; },
    interactionNote(kind) { return this.interactionDisabled(kind) ? "This creator disabled " + kind + " in their TikTok account settings" : ""; },
    onBrandedContentChange() {
      if (this.brandedContent && this.privacy === "SELF_ONLY") this.privacy = "";
    },
    get valid() {
      if (this.unavailable || this.durationExceeded) return false;
      if (this.mode === "inbox") return true;
      if (!this.privacyOptionsView.some((o) => o.value === this.privacy && !o.disabled)) return false;
      if (this.disclosure && !this.brandYourBrand && !this.brandedContent) return false;
      return true;
    },
    options() {
      return {
        tiktokPublishMode: this.mode,
        tiktokPrivacyLevel: this.mode === "direct" ? this.privacy || null : null,
        tiktokDisableComment: this.interactionDisabled("comment") || !this.allowComment,
        tiktokDisableDuet: this.interactionDisabled("duet") || !this.allowDuet,
        tiktokDisableStitch: this.interactionDisabled("stitch") || !this.allowStitch,
        tiktokBrandContentToggle: this.mode === "direct" && this.disclosure && this.brandedContent,
        tiktokBrandOrganicToggle: this.mode === "direct" && this.disclosure && this.brandYourBrand,
      };
    },
  };
};
