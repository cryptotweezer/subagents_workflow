-- Switches macOS Dictation on or off for the app in front, by pressing its own menu item (Edit, Start
-- Dictation), which is what the keyboard shortcut does. Experimental: untested by the author.
--
-- The item is found by its name, in any menu, so it is met in English and in the languages that keep the
-- root of the word (Dictation, Dictado, Dictée, Diktat). Needs Dictation turned on in System Settings,
-- Keyboard, and Accessibility permission for the terminal that runs Claude Code.
--
-- Exit code: 0 pressed, 1 no such menu item or no permission.
tell application "System Events"
	set target to first application process whose frontmost is true
	repeat with heading in menu bar items of menu bar 1 of target
		repeat with entry in menu items of menu 1 of heading
			try
				set title to name of entry
				if title contains "ictat" or title contains "iktat" then
					click entry
					return
				end if
			end try
		end repeat
	end repeat
end tell
error "no dictation menu item" number 1
