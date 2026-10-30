UPDATE api_keys
SET scopes = scopes || ARRAY(
  SELECT scope FROM unnest(ARRAY[
    'brands:read', 'brands:write', 'content:read', 'content:write',
    'posts:read', 'posts:write', 'media:write'
  ]::text[]) AS scope
  WHERE NOT scope = ANY(api_keys.scopes)
)
WHERE scopes @> ARRAY[
  'channels:read', 'channels:write', 'conversations:read', 'conversations:write',
  'contacts:read', 'contacts:write', 'rules:read', 'rules:write',
  'sequences:read', 'sequences:write', 'tags:read', 'tags:write',
  'settings:read', 'settings:write', 'sources:read', 'sources:write',
  'webhooks:read', 'webhooks:write', 'stats:read'
]::text[]
AND NOT scopes @> ARRAY[
  'brands:read', 'brands:write', 'content:read', 'content:write',
  'posts:read', 'posts:write', 'media:write'
]::text[];
