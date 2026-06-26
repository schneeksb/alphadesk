@echo off
REM ============================================================================
REM  AlphaDesk - Market Pulse nightly fetch
REM ----------------------------------------------------------------------------
REM  Runs fetch_transcripts.py, which pulls the latest analyst transcripts,
REM  extracts insights with Claude, and writes them to the Supabase market_pulse
REM  table. Schedule it to run at 7:50 AM daily (before the 8 AM morning brief).
REM
REM  ----- ADD TO WINDOWS TASK SCHEDULER (one-time) -----
REM
REM  EASIEST - one command (run in an ADMIN PowerShell or Command Prompt):
REM
REM    schtasks /Create /TN "AlphaDesk Market Pulse" /TR "C:\Users\schne\OneDrive\Desktop\AlphaDesk\schedule_transcripts.bat" /SC DAILY /ST 07:50 /F
REM
REM  To verify / run it now / remove it:
REM    schtasks /Query  /TN "AlphaDesk Market Pulse"
REM    schtasks /Run    /TN "AlphaDesk Market Pulse"
REM    schtasks /Delete /TN "AlphaDesk Market Pulse" /F
REM
REM  OR via the GUI:
REM    1. Press Win, type "Task Scheduler", open it.
REM    2. Right pane -> "Create Basic Task..."
REM    3. Name: AlphaDesk Market Pulse  ->  Next
REM    4. Trigger: Daily  ->  Next  ->  Start time 7:50:00 AM  ->  Next
REM    5. Action: "Start a program"  ->  Next
REM    6. Program/script: browse to this file:
REM         C:\Users\schne\OneDrive\Desktop\AlphaDesk\schedule_transcripts.bat
REM    7. Finish. (Tip: in the task's Properties, tick "Run whether user is
REM       logged on or not" and "Wake the computer to run this task" if you want
REM       it to fire even when the PC is asleep/locked.)
REM
REM  Output is appended to fetch_transcripts.log in this folder.
REM ============================================================================

cd /d "C:\Users\schne\OneDrive\Desktop\AlphaDesk"
echo ---- %DATE% %TIME% ---- >> fetch_transcripts.log
python fetch_transcripts.py >> fetch_transcripts.log 2>&1
