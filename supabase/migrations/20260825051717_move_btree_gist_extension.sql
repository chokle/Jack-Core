-- Keep extension-owned objects out of the public schema. The authoritative
-- source exclusion constraint remains bound to the existing operator classes
-- after the extension is moved.
alter extension btree_gist set schema extensions;
