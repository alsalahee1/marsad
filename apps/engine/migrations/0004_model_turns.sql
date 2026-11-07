-- The agent loop replays a run's conversation from its tool_calls rows, never from memory.
-- `model_turn` keeps the assistant content blocks (thinking + tool_use) exactly as the model
-- wrote them, so a resumed run hands them back unchanged; the row's output or error becomes the
-- tool_result. Rows from the scripted dev planner leave it NULL.

ALTER TABLE tool_calls ADD COLUMN model_turn JSON NULL AFTER input;
