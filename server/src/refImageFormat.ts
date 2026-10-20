import sharp from 'sharp'

/**
 * GIF is a board animation, not a documented image input for our model
 * contracts. Send its first frame as PNG so providers never receive a raw GIF
 * under image_url(s). A model that needs motion must use a video reference.
 */
export async function imageRefForModel(
  data: Buffer,
  mime: string,
): Promise<{ data: Buffer; mime: string }> {
  const gifSignature = data.subarray(0, 6).toString('ascii')
  if (mime.toLowerCase() !== 'image/gif' && gifSignature !== 'GIF87a' && gifSignature !== 'GIF89a') {
    return { data, mime }
  }
  return {
    data: await sharp(data, { animated: false, page: 0, failOn: 'error' }).png().toBuffer(),
    mime: 'image/png',
  }
}
