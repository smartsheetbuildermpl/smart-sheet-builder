// Physical requests only. Source pixels and the shop's private sheet settings
// are never accepted from the public client.
export const MAX_REQUESTED_SIZE_IN = 120;
export function defaultDesignSize(asset) {
  return { widthIn: asset.widthIn ?? asset.crop.w / 300, heightIn: asset.heightIn ?? asset.crop.h / 300 };
}
export function validDesignSize(size) {
  return [size.widthIn, size.heightIn].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_REQUESTED_SIZE_IN);
}
