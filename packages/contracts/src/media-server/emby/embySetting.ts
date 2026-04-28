import z from 'zod'
import { serviceUrlSchema } from '../../settings/serviceUrl'

/**
 * Schema for Emby server settings.
 * v1 mirrors the Jellyfin connection model: URL + API key + optional admin user.
 */
export const embySettingSchema = z.object({
  emby_url: serviceUrlSchema,
  emby_api_key: z.string().trim().min(1, 'API key is required'),
  emby_user_id: z.string().trim().optional(),
})

export type EmbySetting = z.infer<typeof embySettingSchema>