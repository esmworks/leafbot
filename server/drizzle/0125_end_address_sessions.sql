-- Signing in by username and password or by pairing code is gone: a person reaches the server
-- through their Leaf Bot account, and without it only from the computer it runs on. The sessions
-- those ways made, on devices that reached the server by its address, end here; this computer's own
-- window signs in again with the access key by itself.
DELETE FROM "sessions";
