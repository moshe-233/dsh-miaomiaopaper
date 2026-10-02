/** Video-only groups reuse upstream rotation preparation, selection and playback.
 * No second media player, no timer-driven cuts, no persistent playback history.
 * Inlined in the factory; globals are read only at call time.
 */
function rotationMinimum(group) { return group && group.videoOnly ? 1 : 2; }
function activeVideoPlaylist() {
  const group = activeRotationGroup();
  return selection.rotationEnabled && group && group.videoOnly ? group : null;
}
const videoPlaylistHistory = { groupId: '', ids: [], index: -1 };
function rememberVideoSelection(id) {
  const group = activeVideoPlaylist();
  const h = videoPlaylistHistory;
  if (!group || h.groupId !== group.id) {
    h.groupId = group ? group.id : ''; h.ids = []; h.index = -1;
  }
  if (!group || !id || !rotationCandidates().some((w) => w.id === id)) return;
  if (h.ids[h.index] === id) return;
  h.ids = h.ids.slice(0, h.index + 1); h.ids.push(id);
  if (h.ids.length > 64) h.ids.shift();
  h.index = h.ids.length - 1;
}
function videoPlaylistTarget(ids, current, direction, order, random) {
  if (!ids.length) return '';
  if (ids.length === 1) return ids[0];
  if (direction > 0 && order === 'random') {
    const other = ids.filter((id) => id !== current);
    return other[Math.min(other.length - 1, Math.floor(random() * other.length))] || other[0];
  }
  const i = ids.indexOf(current);
  return ids[(i < 0 ? (direction > 0 ? 0 : ids.length - 1) : i + direction + ids.length) % ids.length];
}
function restartWallpaperVideo() {
  const layer = typeof document !== 'undefined' && document.getElementById(LAYER_ID);
  const video = layer && layer.querySelector('video');
  if (!video) return;
  video._wePlaylistEnded = false;
  try { video.currentTime = 0; } catch { /* metadata not yet available */ }
  applyVideoPlayback(video);
}
function stepWallpaperVideo(direction) {
  const group = activeVideoPlaylist();
  const list = group ? rotationCandidates() : playableInventory();
  const ids = list.map((w) => w.id);
  if (!ids.length) return;
  const h = videoPlaylistHistory;
  let next = '';
  if (group && group.order === 'random') {
    const index = h.index + direction;
    if (h.groupId === group.id && index >= 0 && index < h.ids.length && ids.includes(h.ids[index])) {
      h.index = index; next = h.ids[index];
    }
  }
  if (!next) next = videoPlaylistTarget(ids, selection.id, direction, group ? group.order : 'sequence', Math.random);
  if (next === selection.id) restartWallpaperVideo();
  else applySelection(next, { fromManual: true });
}
function syncVideoPlaylistPlayback(video) {
  const group = activeVideoPlaylist();
  const advancing = Boolean(group && group.order !== 'loop' && rotationCandidates().length > 1);
  video.loop = !advancing;
  if (!advancing || !video.ended) { if (!video.ended) video._wePlaylistEnded = false; return false; }
  // A fading-out video must never advance the NEW selection. Set the latch before
  // preparation can synchronously emit/re-enter playback. Failed candidates are
  // bounded by upstream's excluded set; a manual restart/step permits a retry.
  const layer = typeof document !== 'undefined' && document.getElementById(LAYER_ID);
  if (!layer || layer.querySelector('video') !== video) return true;
  if (isEffectivelyPlaying() && !video._wePlaylistEnded) {
    video._wePlaylistEnded = true;
    beginRotationPrepare(new Set());
  }
  return true;
}
