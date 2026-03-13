import type { CSSProperties } from "react";

export type MaterialSymbolIconWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700;
export type MaterialSymbolIconOpsz = 20 | 24 | 40 | 48;

export interface MaterialSymbolIconProps {
  name: string;
  size?: number;
  filled?: boolean;
  weight?: MaterialSymbolIconWeight;
  grade?: number;
  opsz?: MaterialSymbolIconOpsz;
  className?: string;
  title?: string;
}

const addIconUrl = new URL("../../assets/icons/ui/add.svg", import.meta.url).href;
const arrowForwardIconUrl = new URL("../../assets/icons/ui/arrow-forward.svg", import.meta.url).href;
const blockIconUrl = new URL("../../assets/icons/ui/block.svg", import.meta.url).href;
const browserIconUrl = new URL("../../assets/icons/ui/browser.svg", import.meta.url).href;
const callIconUrl = new URL("../../assets/icons/ui/Call.svg", import.meta.url).href;
const callEndIconUrl = new URL("../../assets/icons/ui/Call Silent.svg", import.meta.url).href;
const cameraIconUrl = new URL("../../assets/icons/ui/Video.svg", import.meta.url).href;
const chatIconUrl = new URL("../../assets/icons/ui/Chat.svg", import.meta.url).href;
const checkIconUrl = new URL("../../assets/icons/ui/check.svg", import.meta.url).href;
const checkCircleIconUrl = new URL("../../assets/icons/ui/check-circle.svg", import.meta.url).href;
const chevronLeftIconUrl = new URL("../../assets/icons/ui/chevron-left.svg", import.meta.url).href;
const chevronRightIconUrl = new URL("../../assets/icons/ui/chevron-right.svg", import.meta.url).href;
const closeIconUrl = new URL("../../assets/icons/ui/close.svg", import.meta.url).href;
const colorizeIconUrl = new URL("../../assets/icons/ui/colorize.svg", import.meta.url).href;
const copyIconUrl = new URL("../../assets/icons/ui/copy-alt.svg", import.meta.url).href;
const deleteIconUrl = new URL("../../assets/icons/ui/delete.svg", import.meta.url).href;
const displayIconUrl = new URL("../../assets/icons/ui/Display 1.svg", import.meta.url).href;
const downloadIconUrl = new URL("../../assets/icons/ui/Download.svg", import.meta.url).href;
const editIconUrl = new URL("../../assets/icons/ui/edit-2.svg", import.meta.url).href;
const expandLessIconUrl = new URL("../../assets/icons/ui/expand-less.svg", import.meta.url).href;
const expandMoreIconUrl = new URL("../../assets/icons/ui/expand-more.svg", import.meta.url).href;
const groupIconUrl = new URL("../../assets/icons/ui/Group 1.svg", import.meta.url).href;
const headphoneIconUrl = new URL("../../assets/icons/ui/headphone.svg", import.meta.url).href;
const hideIconUrl = new URL("../../assets/icons/ui/Hide.svg", import.meta.url).href;
const imageIconUrl = new URL("../../assets/icons/ui/Image 2.svg", import.meta.url).href;
const linkIconUrl = new URL("../../assets/icons/ui/Link.svg", import.meta.url).href;
const lockIconUrl = new URL("../../assets/icons/ui/Lock 1.svg", import.meta.url).href;
const logoutIconUrl = new URL("../../assets/icons/ui/Logout.svg", import.meta.url).href;
const micIconUrl = new URL("../../assets/icons/ui/Microphone 1.svg", import.meta.url).href;
const micOffIconUrl = new URL("../../assets/icons/ui/Microphone Off.svg", import.meta.url).href;
const moreHorizIconUrl = new URL("../../assets/icons/ui/more-horiz.svg", import.meta.url).href;
const moreVertIconUrl = new URL("../../assets/icons/ui/more-vert.svg", import.meta.url).href;
const mobileIconUrl = new URL("../../assets/icons/ui/mobile.svg", import.meta.url).href;
const paperIconUrl = new URL("../../assets/icons/ui/Paper.svg", import.meta.url).href;
const personIconUrl = new URL("../../assets/icons/ui/person.svg", import.meta.url).href;
const profileAcceptedIconUrl = new URL("../../assets/icons/ui/Profile Accepted 2.svg", import.meta.url).href;
const personAddIconUrl = new URL("../../assets/icons/ui/Profile Add 2.svg", import.meta.url).href;
const replyIconUrl = new URL("../../assets/icons/ui/reply.svg", import.meta.url).href;
const returnIconUrl = new URL("../../assets/icons/ui/return.svg", import.meta.url).href;
const screenIconUrl = new URL("../../assets/icons/ui/screen.svg", import.meta.url).href;
const searchIconUrl = new URL("../../assets/icons/ui/Search.svg", import.meta.url).href;
const settingIconUrl = new URL("../../assets/icons/ui/Setting.svg", import.meta.url).href;
const shieldTickIconUrl = new URL("../../assets/icons/ui/Shield Tick.svg", import.meta.url).href;
const smileIconUrl = new URL("../../assets/icons/ui/smile.svg", import.meta.url).href;
const syncIconUrl = new URL("../../assets/icons/ui/sync.svg", import.meta.url).href;
const videoOffIconUrl = new URL("../../assets/icons/ui/video-off.svg", import.meta.url).href;
const visibilityIconUrl = new URL("../../assets/icons/ui/visibility.svg", import.meta.url).href;
const visibilityOffIconUrl = new URL("../../assets/icons/ui/visibility-off.svg", import.meta.url).href;
const volumeOffIconUrl = new URL("../../assets/icons/ui/volume-off.svg", import.meta.url).href;
const volumeUpIconUrl = new URL("../../assets/icons/ui/volume-up.svg", import.meta.url).href;
const wifiIconUrl = new URL("../../assets/icons/ui/Wifi.svg", import.meta.url).href;
const wifiOffIconUrl = new URL("../../assets/icons/ui/wifi-off.svg", import.meta.url).href;
const zoomInIconUrl = new URL("../../assets/icons/ui/Zoom In.svg", import.meta.url).href;
const zoomOutIconUrl = new URL("../../assets/icons/ui/Zoom Out.svg", import.meta.url).href;

const ICON_URLS: Record<string, string> = {
  add: addIconUrl,
  arrow_forward: arrowForwardIconUrl,
  badge: profileAcceptedIconUrl,
  block: blockIconUrl,
  browser: browserIconUrl,
  call: callIconUrl,
  call_end: callEndIconUrl,
  chat: chatIconUrl,
  check: checkIconUrl,
  check_circle: checkCircleIconUrl,
  chevron_left: chevronLeftIconUrl,
  chevron_right: chevronRightIconUrl,
  close: closeIconUrl,
  colorize: colorizeIconUrl,
  delete: deleteIconUrl,
  description: paperIconUrl,
  desktop_windows: displayIconUrl,
  devices: displayIconUrl,
  done: checkIconUrl,
  download: downloadIconUrl,
  edit: editIconUrl,
  expand_less: expandLessIconUrl,
  expand_more: expandMoreIconUrl,
  fullscreen: zoomInIconUrl,
  fullscreen_exit: zoomOutIconUrl,
  group: groupIconUrl,
  groups: groupIconUrl,
  headphones: headphoneIconUrl,
  headset: headphoneIconUrl,
  headset_off: headphoneIconUrl,
  image: imageIconUrl,
  keyboard_return: returnIconUrl,
  link: linkIconUrl,
  lock: lockIconUrl,
  logout: logoutIconUrl,
  mic: micIconUrl,
  mic_off: micOffIconUrl,
  mobile: mobileIconUrl,
  mood: smileIconUrl,
  more_horiz: moreHorizIconUrl,
  more_vert: moreVertIconUrl,
  network_check: wifiIconUrl,
  open_in_new: copyIconUrl,
  person: personIconUrl,
  person_add: personAddIconUrl,
  reply: replyIconUrl,
  restart_alt: syncIconUrl,
  screen_share: screenIconUrl,
  search: searchIconUrl,
  sentiment_satisfied: smileIconUrl,
  settings: settingIconUrl,
  stop_screen_share: hideIconUrl,
  supervisor_account: groupIconUrl,
  sync: syncIconUrl,
  videocam: cameraIconUrl,
  videocam_off: videoOffIconUrl,
  visibility: visibilityIconUrl,
  visibility_off: visibilityOffIconUrl,
  volume_off: volumeOffIconUrl,
  volume_up: volumeUpIconUrl,
  wifi: wifiIconUrl,
  wifi_off: wifiOffIconUrl,
  language: browserIconUrl,
  smartphone: mobileIconUrl,
};

export default function MaterialSymbolIcon({
  name,
  size = 20,
  className,
  title,
}: MaterialSymbolIconProps) {
  const iconUrl = ICON_URLS[name] ?? settingIconUrl;
  const classes = ["ms-icon", className].filter(Boolean).join(" ");
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    minWidth: `${size}px`,
    minHeight: `${size}px`,
    "--ms-icon-url": `url("${iconUrl}")`,
  } as CSSProperties & Record<string, string>;

  const accessibilityProps = title
    ? { role: "img", "aria-label": title, title }
    : { "aria-hidden": true };

  return <span className={classes} style={style} {...accessibilityProps} />;
}
