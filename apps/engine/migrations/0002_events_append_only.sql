-- Second line of defence for the append-only event log. The first is the app user's grants
-- (SELECT, INSERT only). These triggers also stop the migration user, root, or a future
-- ORM from rewriting history. There is no flag, variable, or env var that disables them.

DROP TRIGGER IF EXISTS events_reject_update;

CREATE TRIGGER events_reject_update
  BEFORE UPDATE ON events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'events is append-only: UPDATE rejected';

DROP TRIGGER IF EXISTS events_reject_delete;

CREATE TRIGGER events_reject_delete
  BEFORE DELETE ON events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'events is append-only: DELETE rejected';
