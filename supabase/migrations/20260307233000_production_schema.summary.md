# Production Chat Schema (Messly)

## Tables
- `profiles` (PK: `id -> auth.users.id`)
- `conversations` (PK: `id`, participants: `user1_id`, `user2_id`)
- `messages` (PK: `id`, FK: `conversation_id -> conversations.id`, `sender_id -> profiles.id`)
- `attachments` (PK/FK: `message_id -> messages.id`)
- `message_reads` (PK: `user_id, message_id`; FK: `user_id -> profiles.id`, `message_id -> messages.id`)
- `friend_requests` (PK: `id`; parties: `sender_id`, `receiver_id`; FKs to `profiles.id`)
- `user_blocks` (PK: `blocker_id, blocked_id`; FKs to `profiles.id`)
- `user_presence` (renamed from `presence`; PK: `user_id`; FK: `user_id -> profiles.id`)
- `user_sessions` (PK: `id`; FK: `user_id -> profiles.id`)

## Constraints
- `user_presence.status` check:
  - `online | idle | dnd | offline | invisible`
- `friend_requests` uniqueness:
  - `unique(sender_id, receiver_id)`
- `message_reads` uniqueness:
  - primary key `(user_id, message_id)`
- `user_blocks` uniqueness:
  - primary key `(blocker_id, blocked_id)`

## Performance Indexes
- `messages_conversation_created_idx (conversation_id, created_at desc)`
- `message_reads_user_idx (user_id)`
- `friend_requests_receiver_idx (receiver_id)`
- `user_presence_user_idx (user_id)`

## RLS + Policies
RLS is enabled and forced for:
- `attachments`
- `conversations`
- `friend_requests`
- `message_reads`
- `messages`
- `user_presence`
- `profiles`
- `user_blocks`
- `user_sessions`

Key message policies:
- `messages_select_member`: only conversation participants
- `messages_insert_author`: `auth.uid() = sender_id` and participant
- `messages_update_author`: only author and participant
- `messages_delete_author`: only author and participant

## Realtime Publication
`supabase_realtime` contains:
- `messages`
- `message_reads`
- `user_presence`
