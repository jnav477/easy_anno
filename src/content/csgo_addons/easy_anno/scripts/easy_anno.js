import { Instance, CSPlayerPawn } from "cs_script/point_script";


const ZERO_VELOCITY_VECTOR = { x: 0, y: 0, z: 0 };

class CustomError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

class LineupCache {
  grenade_type = null;
  was_moving = null;
  position = {
    location: null,
    angles: null,
  };

  // Used by /addnextthrow and /addnextshot
  saved_label = null;
  waiting_for_throw = false;
  waiting_for_gunshot = false;

  constructor(context) {
    this.context = context;
  }

  setFromGrenadeProjectile(projectile) {
    this.grenade_type = this.getGrenadeType(projectile);
  }

  setPosition() {
    this.position = this.context.playerPawnManager.getPlayerZeroPosition();
    this.was_moving = this.context.playerPawnManager.playerZeroIsMovingHorizontally();
  };

  isEmpty() {
    return (!this.grenade_type) || (!this.position.location) || (!this.position.angles);
  }

  // Helper function to extract grenade type flag value needed for annotations from projectile entity
  getGrenadeType(grenade_projectile) {
    const projectile_classname = grenade_projectile.GetClassName();

    const grenadeType = projectile_classname
      .replace("_projectile", "")
      .replace("grenade", "")
      .replace("bang", "");

    return grenadeType;
  };
};

class PlayerPawnManager {
  DEFAULT_MAX_MOVEMENT_SPEED = 320;

  constructor(context) {
    this.context = context;
  }

  getPlayerZeroPawn() {
    const player_controller = Instance.GetPlayerController(0);
    return player_controller.GetPlayerPawn();
  }

  getPlayerZeroPosition() {
    const player_zero_pawn = this.getPlayerZeroPawn();
    return this.getPawnPosition(player_zero_pawn);
  }

  playerZeroIsMovingHorizontally() {
    const player_zero_pawn = this.getPlayerZeroPawn();
    const { x, y, z } = player_zero_pawn.GetAbsVelocity();

    // Ignore movement along the vertical z-axis (jumping)
    return (x !== 0) || (y !== 0);
  }

  getPawnPosition(pawn) {

    return {
      location: pawn.GetAbsOrigin(),
      angles: pawn.GetEyeAngles(),
      velocity: ZERO_VELOCITY_VECTOR,
      isCrouched: pawn.IsCrouched(),
    };
  };

  setPosition(position) {
    this.setLocation(position.location);
    this.setLookAngle(position.angles);
  }

  setLocation({ x, y, z }) {
    this.removeMomentum();
    Instance.ServerCommand("noclip 0");

    const setpos_command = `setpos ${x} ${y} ${z}`;
    Instance.ServerCommand(setpos_command);

    this.context.soundEffectPlayer.play(SoundEffect.TELEPORT);
  }

  removeMomentum() {
    const player_pawn = this.getPlayerZeroPawn();
    player_pawn.Teleport({ velocity: ZERO_VELOCITY_VECTOR });
  }

  setLookAngle({ pitch, yaw, roll }) {
    const setang_command = `setang ${pitch} ${yaw} ${roll}`;
    Instance.ServerCommand(setang_command);
  }

  crouch() {
    Instance.ServerCommand("+duck");
  }

  uncrouch() {
    Instance.ServerCommand("-duck");
  }

  crouchForTicks(ticks_to_crouch) {
    this.crouch();
    this.context.scheduler.addTask(ticks_to_crouch, () => this.uncrouch());
  }

  toggleCrouch() {
    if (this.getPlayerZeroPawn().IsCrouched()) {
      this.uncrouch();
      this.context.uiManager.setNotificationMessage("Uncrouched");

    } else {
      this.crouch();
      this.context.uiManager.setNotificationMessage("Crouched. Repeat /crouch (/c) to stand back up again");
    }
  }

  freezeAllPawns() {
    Instance.ServerCommand("sv_maxspeed 0");
  }

  unfreezeAllPawns() {
    Instance.ServerCommand(`sv_maxspeed ${this.DEFAULT_MAX_MOVEMENT_SPEED}`);
  }

  freezeAllPawnsForTicks(ticks_to_freeze) {
    this.freezeAllPawns();
    this.context.scheduler.addTask(ticks_to_freeze, () => this.unfreezeAllPawns());
  }

  freezeMouseMovementForTicks(ticks_to_freeze, angles) {
    // I chose to repeatedly set look angle instead of dropping `m_yaw` and `m_pitch` to 0 just in case any players have these set to a non-default value.
    // Also if the script crashes before unfreezing I don't want the player to be confused why they can't look around in their next game.
    // You can jitter your crosshair around if you try but the annotation will still go to the correct position.

    this.context.scheduler.addContinuousTask(0, ticks_to_freeze,
      () => this.setLookAngle(angles)
    );
  }
}

class Scheduler {
  tasks = [];

  constructor(context) {
    this.context = context;
  }

  // fn will be executed after specified amount of game ticks
  addTask(ticksToWait, fn) {
    this.tasks.push({ continuous: false, ticksToWait, fn, });
  };

  addContinuousTask(ticksToWait, ticksToContinue, fn) {
    // Execute fn every tick for `ticksToContinue` amount of ticks
    this.tasks.push(
      {
        continuous: true,
        ticksToWait,
        ticksRemaining: ticksToContinue,
        fn,
      }
    );
  }

  tick() {
    // Iterate backwards so removing items doesn't skip any tasks
    for (let i = this.tasks.length - 1; i >= 0; i--) {

      const task = this.tasks[i];

      this.handleTask(task, i);

      task.ticksToWait--;
    }
  };

  handleTask(task, index) {
    if (task.ticksToWait > 0)
      return;

    task.fn();

    if (task.continuous && task.ticksRemaining > 0) {
      task.ticksRemaining--;
      return;
    }

    this.removeTask(index);
  }

  removeTask(index) {
    this.tasks.splice(index, 1);
  }
};

class AnnotationJob {
  constructor({ context, grenade_type, label, message }) {
    this.context = context;
    this.grenade_type = grenade_type;
    this.label = label ?? "";
    this.message = message;
  }

  run() {
    const annotation_command = this.getAnnotationCommand();
    Instance.Msg(`annotation_command: ${annotation_command}`);
    Instance.ServerCommand(annotation_command);

    this.context.uiManager.setNotificationMessage(this.message);
    this.context.soundEffectPlayer.play(SoundEffect.CREATE_ANNOTATION);
  }

  getAnnotationCommand() {
    return `annotation_create grenade ${this.grenade_type} "${this.label}"`;
  }
}

const Color = {
  GOLD: { r: 247, g: 209, b: 16 },
  RED: { r: 255, g: 0, b: 0 },
  ORANGE: { r: 255, g: 128, b: 0 },
  GREEN: { r: 0, g: 255, b: 0 },
  BLUE: { r: 0, g: 0, b: 255 },
  LIGHT_BLUE: { r: 0, g: 128, b: 255 },
  BLACK: { r: 0, g: 0, b: 0 },
  WHITE: { r: 255, g: 255, b: 255 },
};

class UIManager {
  debug_mode = false;
  notification_message = "";
  error_message = "";
  detailed_error_message = "";

  constructor(context) {
    this.context = context;
  }

  setNotificationMessage(message) {
    this.notification_message = message;
    this.error_message = "";
  }

  setErrorMessage(message) {
    this.error_message = message;
    this.context.soundEffectPlayer.play(SoundEffect.ERROR);
  }

  setDetailedErrorMessage(message) {
    this.detailed_error_message = message;
  }

  toggleRadar() {
    Instance.ServerCommand("toggle sv_disable_radar 1 0");
    this.setNotificationMessage("Toggled radar visibility.");
  }

  toggleDebugMode() {
    this.debug_mode = !this.debug_mode;
    this.setNotificationMessage(`Debug values ${this.debug_mode ? "displayed" : "hidden"}`);
  }

  showWelcomeMessage() {
    const welcome_message =
      "Welcome to easy_anno, a tool that makes annotating lineups quick and simple.\n" +
      "Use /help for a list of available commands.\n" +
      "Use /demo for a link to the easy_anno demonstration video on YouTube.\n" +
      "Use /preset to load a set of annotations for utility used by easy_anno's creator."
      ;

    this.setNotificationMessage(welcome_message);
  }

  draw() {
    this.drawStandardMessages();

    if (this.debug_mode)
      this.drawDebugMessages();
  }

  drawStandardMessages() {
    const watermark = "easy_anno v1.0 by jnav.exe";

    this.showUnsavedChangesNotice();
    this.showCurrentlyLoadedFileNotice();

    this.drawOnRow(watermark, 1, Color.GOLD);
    this.drawOnRow(this.notification_message, 16, Color.WHITE);
    this.drawOnRow(this.error_message, 22, Color.RED);
  }

  drawOnRow(message, row, color) {
    const X = 10;
    const DURATION = 0.01;
    const y = row * 10;

    Instance.DebugScreenText(message, X, y, DURATION, color);
  }

  showCurrentlyLoadedFileNotice() {
    const storageManager = this.context.storageManager;

    const currently_loaded_file = storageManager.currently_loaded_file;
    const formatted = storageManager.getFormattedFilename(currently_loaded_file);
    const message = `Currently loaded annotation file: ${formatted}`;

    this.drawOnRow(message, 3, Color.WHITE);
  }

  showUnsavedChangesNotice() {
    let message, color;

    if (this.context.storageManager.has_unsaved_changes) {
      message = "You have unsaved changes. Use /save or /saveas before exiting map or they will be lost.";
      color = Color.RED;

    } else {
      message = "All annotations saved. You may quit the map safely.";
      color = Color.GREEN;
    }

    this.drawOnRow(message, 5, color);
  }

  drawDebugMessages() {
    this.showLastThrownGrenade();
    this.showLastThrowPosition();
    this.showIsCrouching();
    this.showPlayerZeroIsMovingHorizontally();
    this.showDetailedErrorMessage();
    this.showSpawnerLocation();
    this.showSpawnerCount();
  }

  showLastThrownGrenade() {
    const message = `lineupCache.grenade_type: ${this.context.lineupCache.grenade_type ?? "null"}`;
    this.drawOnRow(message, 7, Color.WHITE);
  }

  showLastThrowPosition() {
    const { location, angles } = this.context.lineupCache.position;

    let positionMessage;

    if (!location)
      positionMessage = `lineupCache.position.location: null`;

    else {
      const { x, y, z } = location;
      positionMessage = `lineupCache.position.location: { x:${x}, y:${y}, z:${z} }`;
    }

    let anglesMessage;

    if (!angles)
      anglesMessage = `lineupCache.position.angles: null`;
    else {
      const { pitch, yaw, roll } = angles;
      anglesMessage = `lineupCache.position.angles: { pitch:${pitch} yaw:${yaw} roll:${roll} }`;
    }

    this.drawOnRow(positionMessage, 8, Color.WHITE);
    this.drawOnRow(anglesMessage, 9, Color.WHITE);
    this.drawOnRow(`lineupCache.was_moving: ${this.context.lineupCache.was_moving}`, 10, Color.WHITE);
  }

  showIsCrouching() {
    const player_pawn = this.context.playerPawnManager.getPlayerZeroPawn();
    const message = `IsCrouching: ${player_pawn.IsCrouching()}, IsCrouched: ${player_pawn.IsCrouched()}`;
    this.drawOnRow(message, 11, Color.WHITE);
  }

  showPlayerZeroIsMovingHorizontally() {
    const is_moving_horizontally = this.context.playerPawnManager.playerZeroIsMovingHorizontally();
    this.drawOnRow(`playerZeroIsMovingHorizontally(): ${is_moving_horizontally}`, 12, Color.WHITE);
  }

  showSpawnerLocation() {
    try {
      var { x, y, z } = Instance.FindEntityByName("spawner_button_t_1").GetAbsOrigin();
      this.drawOnRow(`spawner_button_t_1: ${x} ${y} ${z}`, 13, Color.WHITE);

      var { x, y, z } = Instance.FindEntityByName("spawner_model_t_1").GetAbsOrigin();
      this.drawOnRow(`spawner_model_t_1: ${x} ${y} ${z}`, 14, Color.WHITE);

    } catch {
      this.drawOnRow(`spawner_button_t_1/spawner_model_t_1 not found: ${x} ${y} ${z}`, 13, Color.WHITE);
    }
  }

  showSpawnerCount() {
    const spawners = this.context.spawnerManager.spawners;
    const count = Object.keys(spawners ?? {}).length;
    this.drawOnRow(`spawner count: ${count}`, 14, Color.WHITE);
  }

  showDetailedErrorMessage() {
    if (this.detailed_error_message) {
      const message = `Detailed error message:${this.detailed_error_message}`;
      this.drawOnRow(message, 20, Color.RED);
    }
  }
}

const SoundEffect = {
  TELEPORT: "\\sounds\\ui\\eom_cardreveal_01",
  CREATE_ANNOTATION: "\\sounds\\ui\\beepclear",
  LOAD: "\\sounds\\ui\\armsrace_level_up_e",
  SAVE: "\\sounds\\buttons\\blip1",
  REMOVE_ANNOTATION: "\\sounds\\ui\\armsrace_level_down",
  ERROR: "\\sounds\\ui\\weapon_cant_buy",
};
class SoundEffectPlayer {
  play(sound_effect) {
    Instance.ServerCommand(`play ${sound_effect}`);
  }
}

class HelpMenu {
  help_table_2d_array = [
    [
      "Command",
      "Example usage",
      "Description"
    ],
    [
      "/help",
      "/help",
      `Prints this command help menu in console.`
    ],
    [
      "/demo",
      "/demo",
      `Prints a link to the easy_anno demonstration YouTube video.`
    ],
    [
      `/cleanup
      /cu`,
      `/cleanup
      /cu`,
      `Kills live grenades (e.g. bloomed smokes and burning mollies).`
    ],
    [
      `/rethrow
      /rt`,
      `/rethrow
      /rt`,
      "Re-throws the last grenade you threw."
    ],
    [
      `/crouch
      /c`,
      `/crouch
      /c`,
      `Toggles crouching state. Useful for annotation crouching AND moving (can't use /autoadd, but also can't type in chat without releasing CTRL).`
    ],
    [
      `/autoadd <label (Optional)>
      /a <label (Optional)>`,
      `/autoadd Monster smoke
      /a Monster smoke`,
      `Auto-annotates your last-thrown grenade, teleporting you back to the position you originally threw it from.

      Note: Can be used for standing, crouching, and jumping throws, but NOT for moving throws. To annotate moving throws, use /addnextthrow or /addlastthrow instead.`
    ],
    [
      `/addlastthrow <label (Optional)>
      /alt <label (Optional)>`,
      `/addlastthrow Window smoke
      /alt <label (Optional)>`,
      `Annotates your last-thrown grenade using your current position.
      
      To use:
      1. Throw a grenade
      2. Go back to the original lineup position
      3. Stand still and use the /alt command
      4. The annotation will be created where your crosshair is aiming`
    ],
    [
      `/addnextthrow <label (Optional)>
      /ant <label (Optional)>`,
      `/addnextthrow Window smoke
      /ant <label (Optional)>`,
      `Annotates the next grenade you throw using your current position.
      
      To use:
      1. Stand in the lineup position
      2. Use the /ant command (you'll be notified that the command is "primed")
      3. Throw the grenade
      4. The annotation will be created where your crosshair was aiming when you executed the /ant command`
    ],
    [
      `/addshot <label (Optional)>
      /as <label (Optional)>`,
      `/addnextshot Connector smoke
      /as Connector smoke`,
      `Annotates your last grenade using the next position you fire a weapon from. Useful for lineups where are unable to type /add in chat (e.g. crouching AND moving).
      
      To use:
      1. Throw a grenade
      2. Use the /addshot or /as command (you'll be notified that the command has been "primed")
      3. Return to the original lineup position and fire any weapon
      4. The annotation will be created where your crosshair was aiming aiming when you executed the /ans command`
    ],
    [
      `/addspot
      /spot`,
      `/addspot
      /spot`,
      `Creates a floating spot where your crosshair is currently aiming.

      Note: Unlike with add and addm this does not save your standing position, or where the grenade lands.`
    ],
    [
      `/addtext [<title (Optional)>] [<description (Optional)>]

      /text [<title (Optional)>] [<description (Optional)>]`,
      `/addtext [This text will be large] [This text will be small]

      /text [This text will be large] [This text will be small]`,
      `Creates a floating text annotation that faces the player.

      Important: Whenever passing more than one parameter, remember to wrap them in square brackets [] as per the example usage.
      
      Note:
      - You may omit title OR description, but not both.`
    ],
    [
      "/undo",
      "/undo",
      `Deletes the last annotation created.`
    ],
    [
      "/clearall",
      "/clearall",
      `Clears all currently loaded annotations. (Does not automatically override save file).
      
      WARNING: Cleared annotations cannot be restored.`
    ],
    [
      "/save",
      "/save",
      `Saves all changes to the currently loaded file.`
    ],
    [
      "/saveas <filename>",
      "/saveas new_nuke_nades",
      `Saves all currently loaded annotations to a new file. Useful if you hit the maximum annotation limit on the default
      Important: Filename cannot contain spaces.

      WARNING: If a file with the given filename already exists, its contents will be overwritten.`
    ],
    [
      "/load <filename>",
      "/load new_nuke_nades",
      `Loads annotations from the specified file. 
      
      Note:
      - Annotation file must be in the default save location (You can use /files to get the path to this folder).
      - See /demo for instructions for loading annotations downloaded from the Steam Workshop.
      - If specified file does not exist, it will be created when you use /save.`
    ],
    [
      "/loaddefault",
      "/loaddefault",
      "Loads annotations from the default save location (easy_anno_<mapname>.txt)."
    ],
    [
      "/preset",
      "/preset",
      "Appends a set of pre-loaded annotations for utility used by easy_anno's creator."
    ],
    [
      "/reload",
      "/reload",
      "Re-loads currently loaded annotations. Can fix bug where certain annotation elements are not showing properly."
    ],
    [
      "/append <filename>",
      "/append other_ancient_nades",
      `Adds all annotations from the specified annotation file without deleting existing ones.

      Note: Remember to save after appending. Appended annotations are not automatically saved.`
    ],
    [
      "/discard",
      "/discard",
      `Reloads currently loaded annotation file, discarding all unsaved annotations.

      WARNING: Any annotations that have not been saved will be permanently lost.`
    ],
    [
      "/files",
      "/files",
      `Prints the path to the Windows folder where annotation files are saved by default.

      Note: May be inaccurate if Counter-Strike 2 is not installed in the default location.`
    ],
    [
      "/spawns",
      "/spawns",
      "Toggles visibility of spawnpoint teleporters."
    ],
    [
      "/radar",
      "/radar",
      `Toggles visibility of radar.
      
      Note: Radar is disabled by default to not cover UI messages.`
    ],
    [
      "/restart",
      "/restart",
      `Restarts match. May be useful for fixing certain bugs that occur.
      
      WARNING: Any unsaved changes will be lost.
      `,
    ],
    [
      "/debug",
      "/debug",
      "Toggle hide/show debug message display"
    ],
  ];
  table_printer;
  NUM_OF_COLUMNS = 3;
  MAX_COLUMN_WIDTH = 48;


  constructor(context) {
    this.context = context;

    this.table_printer = new TablePrinter(this.NUM_OF_COLUMNS, this.MAX_COLUMN_WIDTH);
    this.table_printer.from2DArray(this.help_table_2d_array);
  }

  printHeader() {
    Instance.Msg("");
    Instance.Msg("=== easy_anno v1.0 ===");
    Instance.Msg("");
  }

  printAnnotationFolderPath() {
    this.printHeader();

    const FOLDER_PATH = "C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/annotations/local";
    const message = `Default Windows save location for annotation files: ${FOLDER_PATH}`;

    // Print in console and in-game chat
    Instance.Msg(message);
    this.context.chatManager.sendChatMessage(message, true);

    this.context.uiManager.setNotificationMessage(
      "Check console or in-game chat for default annotation folder location"
    );
  }

  printDemoLink() {
    this.printHeader();

    const VIDEO_LINK = "https://youtu.be/DPoonBCAjiw";
    const message = `Watch the easy_anno demo video: ${VIDEO_LINK}`;

    // Print in console and in-game chat
    Instance.Msg(message);
    this.context.chatManager.sendChatMessage(message, true);

    this.context.uiManager.setNotificationMessage(
      "Check console or in-game chat for link to easy_anno demo video."
    );
  }

  printHelp() {
    this.printHeader();

    // Print note
    const note_lines =
      [
        "Note: Execute these commands by typing in game (NOT in the developer console), and\n" +
        "make sure to INCLUDE the square brackets '[]' if you are trying to pass more than one parameter to a command."
      ];

    for (const line of note_lines)
      Instance.Msg(line);

    // Print help table
    const table_string = this.table_printer.toString();
    const table_lines = table_string.split("\n");

    for (const line of table_lines)
      Instance.Msg(line);

    this.context.uiManager.setNotificationMessage("Open your console for a detailed list of commands.");
  }
}

class TablePrinter {
  column_count;
  max_cell_width;
  table_string;

  constructor(column_count, max_cell_width) {
    this.column_count = column_count;
    this.max_cell_width = max_cell_width;
  }

  from2DArray(cell_array) {
    const normalized = this.normalizeRows(cell_array);
    const wrapped = this.wrapCellContent(normalized);
    const column_widths = this.getColumnWidths(wrapped);
    this.table_string = this.renderTableString(wrapped, column_widths);
  }

  toString() {
    return this.table_string;
  }

  // Ensures every row has `column_count` amount of columns, truncating or padding with empty cells where necessary
  normalizeRows(cell_array) {
    return cell_array.map(oldRow => {

      const newRow = oldRow.slice(0, this.column_count); // Truncate if too long

      while (newRow.length < this.column_count)
        newRow.push(""); // Right-pad with empty cells if too short

      return newRow;
    });
  }

  wrapCellContent(normalized_cell_array) {
    return normalized_cell_array.map(row =>
      row.map(cell =>
        this.getCellLines(cell)
      )
    );
  }

  // Breaks up long string into array of strings shorter than this.max_cell_width
  getCellLines(cell_content) {
    const input_lines = cell_content.split("\n");
    const output_lines = [];

    for (let input_line of input_lines) {
      input_line = input_line.trimEnd();

      // Preserve blank lines by insta-pushing them
      if (!input_line) {
        output_lines.push("");
        continue;
      }

      const words = input_line.split(/\s+/);

      let line = "";

      for (let word of words) {

        if (word.length > this.max_cell_width) {
          const { chunks, remainder } = this.splitLongWord(word);
          output_lines.push(...chunks);
          word = remainder;
        }

        const is_first_word_of_line = (!line);
        const word_fits_on_line = (line + " " + word).length <= this.max_cell_width;

        if (is_first_word_of_line)
          line = word;

        else if (word_fits_on_line)
          line += " " + word;

        else {
          // Push current line. Current word will be the first word of the NEXT line
          output_lines.push(line);
          line = word;
        }
      }

      // Once there are no words left, add any remaining words to output
      if (line)
        output_lines.push(line);
    }

    if (output_lines.length > 0)
      return output_lines;
    else
      return [""];
  }

  // Split word into chunks of length `this.max_cell_width`
  splitLongWord(word) {
    const chunks = [];

    while (word.length > this.max_cell_width) {
      const chunk = word.slice(0, this.max_cell_width);
      chunks.push(chunk);
      word = word.slice(this.max_cell_width);
    }

    return { chunks, remainder: word };
  }

  // Builds array such that nth element is character width of nth column after wrapping
  getColumnWidths(wrapped_cell_array) {
    const column_widths = Array(this.column_count).fill(0);

    for (const row of wrapped_cell_array) {
      row.forEach((cell, column_index) => {

        let longest_line_length = 0;

        cell.forEach(line => {
          if (line.length > longest_line_length)
            longest_line_length = line.length;
        });

        if (longest_line_length > column_widths[column_index])
          column_widths[column_index] = longest_line_length;
      });
    }

    return column_widths;
  }

  renderTableString(cell_array, column_widths) {
    const horizontal_divider = this.getHorizontalDivider(column_widths);

    let output = "";

    // Very top edge of table
    output += horizontal_divider + "\n";

    for (const row of cell_array) {
      const row_height = this.getRowHeight(row);

      for (let row_line = 0; row_line < row_height; row_line++) {

        output += "|"; // Very left edge of table

        for (let column_index = 0; column_index < this.column_count; column_index++) {
          const cell_line = row[column_index][row_line] ?? "";
          output += " " + this.pad(cell_line, column_widths[column_index]) + " |"; // Adds right edge of each column
        }

        output += "\n";
      }

      // Bottom edge of each row
      output += horizontal_divider + "\n";
    }

    return output;
  }

  getHorizontalDivider(column_widths) {
    const dashes = column_widths.map(width => "-".repeat(width + 2));
    return "+" + dashes.join("+") + "+";
  }

  getRowHeight(row) {
    return Math.max(...row.map(c => c.length));
  }

  pad(text, width) {
    if (text.length >= width)
      return text.slice(0, width);

    else
      return text + " ".repeat(width - text.length);
  }
}

class ChatManager {
  // Chat messages with this prefix will be ignored by command parser
  prefix = "[easy_anno]";

  constructor(context) {
    this.context = context;
  }

  // Intended for messages that the player needs to copy and paste. Otherwise, use UIManager#setNotificationMessage
  sendChatMessage(message, include_copy_tip) {
    const copy_tip = "(Tip) To copy text from chat: Left-click & drag to highlight, then right-click and select 'Copy highlighted text'.";

    if (include_copy_tip) {
      this.context.scheduler.addTask(16,
        () => Instance.ServerCommand(`say "${this.prefix} ${copy_tip}"`)
      );
    }

    this.context.scheduler.addTask(48,
      () => Instance.ServerCommand(`say "${this.prefix} ${message}"`)
    );
  }

  showReloadTip() {
    const message = "Tip: Use /reload if annotation elements aren't rendering properly (common after respawning).";
    this.sendChatMessage(message, false);
  }

  handlePlayerChat({ text }) {
    if (text.trim().startsWith("/")) {
      const { cmd, args } = this.parseCommand(text);
      this.handleChatCommand(cmd, args, text);
    }
  }

  handleChatCommand(cmd, args, text) {
    try {
      switch (cmd) {
        case "help":
          return this.context.helpMenu.printHelp();

        case "demo":
          return this.context.helpMenu.printDemoLink();

        case "cleanup":
        case "cu":
          return this.context.easyAnno.cleanup();

        case "rethrow":
        case "rt":
          return this.context.easyAnno.rethrow();

        case "crouch":
        case "c":
          return this.context.playerPawnManager.toggleCrouch();

        case "autoadd":
        case "a":
          return this.context.easyAnno.createAnnotationFromCachedThrowPosition(args[0]);

        case "addlastthrow":
        case "alt":
          return this.context.easyAnno.createAnnotationUsingCurrentPosition(args[0]);

        case "addnextthrow":
        case "ant":
          return this.context.easyAnno.primeAddNextThrow(args[0]);

        case "addshot":
        case "as":
          return this.context.easyAnno.primeAddNextShot(args[0]);

        case "addspot":
        case "spot":
          return this.context.easyAnno.addSpot();

        case "addtext":
        case "text":
          this.validateParameterCount(cmd, 1, args);
          return this.context.easyAnno.addText(args[0], args[1]);

        case "undo":
          return this.context.easyAnno.undoLastAnnotation();

        case "clearall":
          return this.context.easyAnno.clearAllAnnotations();

        case "save":
          // Note: Reject if the typed command contained any more than "/save" (in case user meant to use /saveas)
          // TODO: This one check makes this method require text even though none of the other commands need it
          // Maybe rework so this check is reusable for other destructive commands
          if (text.replace(/\s/g, "") !== "/save") {
            const message = "Command /save does not take any parameters. Did you mean to use /saveas?";
            throw new CustomError(message);
          }

          return this.context.storageManager.saveCurrentlyLoadedFile();

        case "saveas":
          this.validateParameterCount(cmd, 1, args);
          return this.context.storageManager.saveAnnotations(args[0]);

        case "load":
          this.validateParameterCount(cmd, 1, args);
          return this.context.storageManager.loadAnnotationFile(args[0]);

        case "loaddefault":
          return this.context.storageManager.loadDefaultAnnotationFile();

        case "preset":
          return this.context.storageManager.appendPresetAnnotations();

        case "reload":
          return this.context.storageManager.reloadCurrentAnnotations();

        case "append":
          this.validateParameterCount(cmd, 1, args);
          return this.context.storageManager.appendAnnotations(args[0]);

        case "discard":
          return this.context.storageManager.discardUnsavedChanges();

        case "files":
          return this.context.helpMenu.printAnnotationFolderPath();

        case "spawns":
          return this.context.spawnerManager.toggleSpawnerVisibility();

        case "radar":
          return this.context.uiManager.toggleRadar();

        case "restart":
          return this.context.serverManager.restart();

        case "debug":
          return this.context.uiManager.toggleDebugMode();

        default:
          this.context.uiManager.setErrorMessage(`Command /${cmd} not recognized. Type /help in chat for a detailed list of commands.`);
      }

    } catch (error) {
      if (error instanceof CustomError)
        this.displayChatCommandError(cmd, error.message);

      else {
        Instance.Msg(error.message);
        this.context.uiManager.setDetailedErrorMessage(error.message);
      }
    }
  }

  // First word is command name, then parameters are wrapped in square brackets
  // Example: text = "commandName [Parameter value 1] [Parameter value 2]"
  parseCommand(text) {
    text = text.trim();

    // Remove leading slash
    if (text.startsWith("/"))
      text = text.slice(1);

    text = text.trim(); // Handles errant space after slash (e.g. / add)

    // cmd = First word
    const cmd = text.split(/\s+/)[0];
    let rest_of_text = text.slice(cmd.length).trim();

    // Would've preferred double-quotes ("") but they're auto-removed by the game :(
    const in_square_brackets = /\[([^\]]*)\]/g; // Match strings in square brackets e.g. [Parameter 1]
    const matches_iterator = rest_of_text.matchAll(in_square_brackets);
    const matches_array = [...matches_iterator]; // Shorthand for converting iterator to array
    let args = matches_array.map(m => m[1]); // Each match is an array where [1] is the matched string itself


    if (args.length === 0) { // No bracketed params
      if (rest_of_text.length > 0) // One unbracketed param
        args = [rest_of_text];
    }

    return { cmd, args };
  }

  displayChatCommandError(command, error_details) {
    const message = `Failed to execute command /${command}. Type /help in chat for command usage details.\n${error_details}`;
    this.context.uiManager.setErrorMessage(message);
  }

  validateParameterCount(cmd, min_args, args) {
    if (args.length < min_args)
      throw new CustomError(`Command /${cmd} requires ${min_args} parameter(s). You may have forgotten to include square brackets [] around parameters.`);
  }
}

class StorageManager {
  has_unsaved_changes = false;
  currently_loaded_file = this.getDefaultAnnotationFilename();

  constructor(context) {
    this.context = context;
  }

  getDefaultAnnotationFilename() {
    const map_name = Instance.GetMapName();
    let default_annotation_filename = map_name.replace("de_", "easy_anno_");

    if (default_annotation_filename === map_name)
      default_annotation_filename = `easy_anno_${default_annotation_filename}`;

    return default_annotation_filename;
  }

  getPresetAnnotationsFilename() {
    const HAS_PRESET = [
      "de_dust2",
      "de_ancient",
      "de_inferno",
      "de_mirage",
      "de_anubis",
      "de_nuke",
      "de_overpass",
    ];

    const map_name = Instance.GetMapName();

    if (!HAS_PRESET.includes(map_name))
      throw new CustomError(`No preset annotations. Map creator doesn't know any grenades on ${map_name} (xD)`);

    return map_name.replace("de_", "easy_anno_preset_");
  }

  getFormattedFilename(filename) {
    // Adds .txt and "(Default file)" if appropriate
    let formatted = `${filename}.txt`;

    if (filename === this.getDefaultAnnotationFilename())
      formatted = `${formatted} (Default file)`;

    return formatted;
  }

  validateFilename(filename, attempting_to_save) {
    if (filename.includes(" "))
      throw new CustomError("Filename cannot contain spaces.");

    if (filename.includes("."))
      throw new CustomError("Filename should not contain extensions (e.g. '.txt').\nThe extension .txt will be added automatically.");

    // Allow LOADING from preset file, but NOT saving (overwriting) it
    if (attempting_to_save && filename.startsWith("easy_anno_preset_"))
      throw new CustomError("This is the file that the preset example annotations are saved to.\nPlease choose a different filename.");
  }

  validateNoUnsavedChanges() {
    const UNSAVED_CHANGES_WARNING = "You currently have unsaved changes.\n" +
      "Use /save or /saveas to if you don't want to lose them.\n" +
      "Use /append to load annotations without clearing currently existing ones.\n" +
      "Use /discard to permanently remove them.";

    if (this.has_unsaved_changes)
      throw new CustomError(UNSAVED_CHANGES_WARNING);
  }

  saveCurrentlyLoadedFile() {
    this.saveAnnotations(this.currently_loaded_file);
  }

  saveAnnotations(filename) {
    this.validateFilename(filename, true);

    Instance.ServerCommand(`annotation_save ${filename}`);
    this.has_unsaved_changes = false;
    this.currently_loaded_file = filename;

    const formatted = this.getFormattedFilename(filename);
    let message = `Saved annotations to ${formatted}`;

    this.context.uiManager.setNotificationMessage(message);
    this.context.soundEffectPlayer.play(SoundEffect.SAVE);
  }

  loadDefaultAnnotationFile() {
    const filename = this.getDefaultAnnotationFilename();

    // Load annotation file or create one if it doesn't exist yet
    this.loadAnnotationFile(filename);
  }

  loadAnnotationFile(filename) {
    this.validateFilename(filename, false);
    this.validateNoUnsavedChanges();

    Instance.ServerCommand(`annotation_load ${filename}`);

    this.currently_loaded_file = filename;
    this.has_unsaved_changes = false;

    const formatted = this.getFormattedFilename(filename);
    let message = `Loaded annotations from ${formatted}`;

    this.context.uiManager.setNotificationMessage(message);
    this.context.soundEffectPlayer.play(SoundEffect.LOAD);
  }

  reloadCurrentAnnotations() {
    this.loadAnnotationFile(this.currently_loaded_file);
  }

  appendAnnotations(filename) {
    this.validateFilename(filename, false);

    // Note: Use of /append is prevented if there are unsaved changes because undoing append requires doing /undo for every annotation appended
    // If in future `annotation_append` was made reversible with one command this check could be removed.
    this.validateNoUnsavedChanges();

    Instance.ServerCommand(`annotation_append ${filename}`);
    this.context.storageManager.has_unsaved_changes = true;

    this.context.uiManager.setNotificationMessage(`Appended annotations from ${filename}.txt`);
  }

  appendPresetAnnotations() {
    const preset_annotations_filename = this.getPresetAnnotationsFilename();
    this.appendAnnotations(preset_annotations_filename);
    this.context.uiManager.setNotificationMessage(`Appended premade annotation set for ${Instance.GetMapName()}`);
  }

  discardUnsavedChanges() {
    this.has_unsaved_changes = false;
    this.loadAnnotationFile(this.currently_loaded_file);

    const formatted = this.getFormattedFilename(this.currently_loaded_file);

    this.context.uiManager.setNotificationMessage(`Discarded all changes to ${formatted}`);
    this.context.soundEffectPlayer.play(SoundEffect.REMOVE_ANNOTATION);
  }
}

class ServerManager {
  constructor(context) {
    this.context = context;
  }

  setupServer() {
    const server_setup_commands = `
      gamemode_competitive;
      sv_cheats 1;
      sv_disable_radar 1;
      mp_autokick 0;
      mp_limitteams 0;
      mp_autoteambalance 0;
      mp_match_end_changelevel 0;
      mp_ignore_round_win_conditions 0;
      mp_roundtime 60;
      mp_roundtime_defuse 60;
      mp_maxmoney 60000;
      mp_startmoney 60000;
      mp_freezetime 0;
      mp_buytime 9999;
      mp_buy_anywhere 1;
      mp_ct_default_grenades weapon_smokegrenade weapon_flashbang weapon_hegrenade weapon_incgrenade
      mp_t_default_grenades weapon_smokegrenade weapon_flashbang weapon_hegrenade weapon_molotov
      sv_infinite_ammo 2;
      ammo_grenade_limit_total 5;
      cl_versus_intro 0;
      mp_team_intro_time 0;
      bot_kick;
      sv_grenade_trajectory_prac_pipreview 1;
      sv_grenade_trajectory_prac_trailtime 5;
      sv_showimpacts_time 10;
      player_ping_token_cooldown 0;
      buddha 1;
      buddha_reset_hp 100;
      sv_regeneration_force_on 1;
      sv_allow_annotations 1;
      annotation_auto_load 0;
      mp_round_restart_delay 1;
      mp_restartgame 1;
      mp_warmup_end;
    `;

    Instance.ServerCommand(server_setup_commands);
  }

  restart() {
    this.setupServer();
    this.context.uiManager.setNotificationMessage("Restarting match...");
  }
}

class Spawner {
  constructor(button, model) {
    this.button = button;
    this.model = model;
  }

  getButton() {
    return this.button;
  }

  getModel() {
    return this.model;
  }
}

class SpawnerManager {
  // Spawners are not glowing initially (i.e. in extension_map.vmap, "Glow State" = "OFF")
  spawners_visible = false;

  // Note: Keys are <spawn_id>s, meaning a value like ct_1, ct_2, t_1, t_2
  spawners;

  spawnpoints = {
    test_map: {
      ct_1: { x: -34.819397, y: -418.104858, z: 64.031250 },
      ct_2: { x: -134.819397, y: -418.104858, z: 64.031250 },
      t_1: { x: 246.540939, y: -470.340454, z: 64.031250 },
      t_2: { x: 146.540939, y: -470.340454, z: 64.031250 },
    },

    de_nuke: {
      t_1: { x: -1878.00, y: -980.00, z: -409.96 },
      t_2: { x: -1808.00, y: -1025.00, z: -409.96 },
      t_3: { x: -1874.00, y: -1076.00, z: -409.96 },
      t_4: { x: -1947.01, y: -965.10, z: -409.96 },
      t_5: { x: -1947.01, y: -1102.10, z: -409.96 },
      t_6: { x: -1832.00, y: -1160.00, z: -409.96 },
      t_7: { x: -1929.00, y: -1025.00, z: -409.96 },
      t_8: { x: -1808.00, y: -1089.00, z: -409.96 },

      ct_1: { x: 2512.00, y: -504.00, z: -343.40 },
      ct_2: { x: 2504.00, y: -344.00, z: -345.96 },
      ct_3: { x: 2584.00, y: -504.00, z: -345.96 },
      ct_4: { x: 2585.00, y: -344.00, z: -345.96 },
      ct_5: { x: 2552.00, y: -424.00, z: -345.96 },
    },

    de_dust2: {
      ct_1: { x: 351.392120, y: 2352.942383, z: -120.474915 },
      ct_2: { x: 334.368744, y: 2433.733643, z: -120.362549 },
      ct_3: { x: 258.159393, y: 2480.553711, z: -121.076660 },
      ct_4: { x: 182.249908, y: 2439.011719, z: -120.968750 },
      ct_5: { x: 160.122742, y: 2369.676270, z: -119.918701 },

      t_1: { x: -332.000000, y: -754.000000, z: 78.877106 },
      t_2: { x: -367.000000, y: -808.000000, z: 83.744965 },
      t_3: { x: -428.000000, y: -843.000000, z: 95.245865 },
      t_4: { x: -493.000000, y: -808.000000, z: 108.600000 },
      t_5: { x: -533.000000, y: -754.000000, z: 113.848976 },
      t_6: { x: -657.271362, y: -755.879639, z: 116.708206 },
      t_7: { x: -696.844604, y: -806.623718, z: 116.708206 },
      t_8: { x: -760.662964, y: -836.174011, z: 117.071777 },
      t_9: { x: -822.365173, y: -795.642090, z: 117.264000 },
      t_10: { x: -857.506531, y: -738.361328, z: 122.089119 },
      t_11: { x: -980.764830, y: -754.000000, z: 120.181259 },
      t_12: { x: -1015.000000, y: -808.000000, z: 116.082619 },
      t_13: { x: -1076.000000, y: -843.000000, z: 116.789467 },
      t_14: { x: -1141.000000, y: -808.000000, z: 116.685989 },
      t_15: { x: -1181.000000, y: -754.000000, z: 120.181252 },
    },

    de_ancient: {
      t_1: { x: -584.00, y: -2288.00, z: -156.79 },
      t_2: { x: -456.00, y: -2288.00, z: -157.25 },
      t_3: { x: -328.00, y: -2288.00, z: -157.25 },
      t_4: { x: -520.00, y: -2224.00, z: -157.25 },
      t_5: { x: -392.00, y: -2224.00, z: -157.25 },

      ct_1: { x: -256.00, y: 1728.00, z: 30.94 },
      ct_2: { x: -192.00, y: 1696.00, z: 30.76 },
      ct_3: { x: -448.00, y: 1728.00, z: 35.33 },
      ct_4: { x: -352.00, y: 1728.00, z: 33.64 },
      ct_5: { x: -512.00, y: 1696.00, z: 30.75 },
    },

    de_anubis: {
      t_1: { x: -384.00, y: -1552.00, z: -6.03 },
      t_2: { x: -328.00, y: -1528.00, z: -6.03 },
      t_3: { x: -234.00, y: -1503.07, z: -6.03 },
      t_4: { x: -154.00, y: -1503.07, z: -6.03 },
      t_5: { x: -304.00, y: -1608.00, z: -6.03 },
      t_6: { x: -240.00, y: -1696.00, z: 8.03 },
      t_7: { x: -264.00, y: -1560.00, z: -6.03 },
      t_8: { x: -416.00, y: -1608.00, z: 1.56 },
      t_9: { x: -144.00, y: -1568.00, z: -6.03 },
      t_10: { x: -128.00, y: -1632.00, z: -3.10 },
      t_11: { x: -416.00, y: -1696.00, z: 8.03 },

      ct_1: { x: -608.00, y: 2120.00, z: 22.04 },
      ct_2: { x: -400.00, y: 2192.00, z: 24.35 },
      ct_3: { x: -476.00, y: 2216.00, z: 30.28 },
      ct_4: { x: -560.00, y: 2192.00, z: 24.34 },
      ct_5: { x: -360.00, y: 2120.00, z: 22.05 },
    },

    de_inferno: {
      t_1: { x: -1520.06, y: 430.89, z: -58.03 },
      t_2: { x: -1586.52, y: 440.79, z: -58.03 },
      t_3: { x: -1657.23, y: 419.58, z: -58.03 },
      t_4: { x: -1675.61, y: 351.69, z: -58.03 },
      t_5: { x: -1662.18, y: 288.76, z: -58.03 },

      ct_1: { x: 2493.00, y: 2090.00, z: 138.36 },
      ct_2: { x: 2292.06, y: 2027.69, z: 141.45 },
      ct_3: { x: 2397.00, y: 2079.00, z: 138.61 },
      ct_4: { x: 2456.83, y: 2153.16, z: 138.05 },
      ct_5: { x: 2353.00, y: 1977.00, z: 141.07 },
      ct_6: { x: 2472.34, y: 2005.96, z: 139.86 },
    },

    de_mirage: {
      t_1: { x: 1216.00, y: -115.00, z: -160.95 },
      t_2: { x: 1216.00, y: -211.00, z: -158.60 },
      t_3: { x: 1136.00, y: 32.00, z: -158.78 },
      t_4: { x: 1136.00, y: -64.00, z: -158.69 },
      t_5: { x: 1136.00, y: -256.00, z: -158.83 },
      t_6: { x: 1296.00, y: 32.00, z: -161.96 },
      t_7: { x: 1216.00, y: -307.04, z: -158.81 },
      t_8: { x: 1136.00, y: -160.00, z: -158.66 },
      t_9: { x: 1296.00, y: -352.00, z: -161.96 },
      t_10: { x: 1216.00, y: -16.00, z: -160.95 },

      ct_1: { x: -1776.00, y: -1976.00, z: -260.06 },
      ct_2: { x: -1656.00, y: -1976.00, z: -261.90 },
      ct_3: { x: -1720.00, y: -1896.00, z: -262.12 },
      ct_4: { x: -1656.00, y: -1800.00, z: -261.80 },
      ct_5: { x: -1776.00, y: -1800.00, z: -260.18 },
    },

    de_overpass: {
      t_1: { x: -1448.00, y: -3076.00, z: 267.44 },
      t_2: { x: -1363.00, y: -3122.00, z: 262.90 },
      t_3: { x: -1422.38, y: -3129.72, z: 270.70 },
      t_4: { x: -1395.00, y: -3190.00, z: 274.52 },
      t_5: { x: -1391.00, y: -3262.00, z: 282.41 },
      t_6: { x: -1510.39, y: -3053.88, z: 286.30 },
      t_7: { x: -1453.00, y: -3335.00, z: 298.10 },
      t_8: { x: -1387.00, y: -3342.00, z: 291.24 },
      t_9: { x: -1620.00, y: -3176.00, z: 310.03 },
      t_10: { x: -1459.00, y: -3262.00, z: 290.32 },
      t_11: { x: -1499.00, y: -3126.00, z: 279.18 },

      ct_1: { x: -2343.00, y: 797.00, z: 482.03 },
      ct_2: { x: -2275.00, y: 842.00, z: 482.03 },
      ct_3: { x: -2273.00, y: 770.00, z: 482.03 },
      ct_4: { x: -2190.00, y: 817.00, z: 482.04 },
      ct_5: { x: -2199.00, y: 740.00, z: 482.03 },
    },

    de_vertigo: {
      t_1: { x: -1332.03, y: -1453.23, z: 11488.03 },
      t_2: { x: -1293.39, y: -1328.16, z: 11488.03 },
      t_3: { x: -1405.82, y: -1455.42, z: 11488.03 },
      t_4: { x: -1467.46, y: -1428.66, z: 11488.03 },
      t_5: { x: -1296.70, y: -1392.42, z: 11488.03 },

      ct_1: { x: -1085.99, y: 813.93, z: 11782.03 },
      ct_2: { x: -1031.31, y: 861.96, z: 11782.03 },
      ct_3: { x: -944.85, y: 858.47, z: 11782.03 },
      ct_4: { x: -903.64, y: 779.09, z: 11782.03 },
      ct_5: { x: -930.66, y: 701.07, z: 11782.03 },
    },

    de_train: {
      t_1: { x: -2000.000000, y: 1434.233154, z: -171.968750 },
      t_2: { x: -2033.000000, y: 1362.233154, z: -171.968750 },
      t_3: { x: -1916.000000, y: 1456.233154, z: -171.968750 },
      t_4: { x: -1925.000000, y: 1394.000000, z: -171.968750 },
      t_5: { x: -1955.000000, y: 1326.000000, z: -171.968750 },
      t_6: { x: -1850.000000, y: 1256.000000, z: -171.968750 },

      ct_1: { x: 1378.000000, y: -1244.000000, z: -327.733521 },
      ct_2: { x: 1462.000000, y: -1226.000000, z: -327.945557 },
      ct_3: { x: 1552.000000, y: -1232.000000, z: -327.759521 },
      ct_4: { x: 1456.000000, y: -1328.000000, z: -327.968750 },
      ct_5: { x: 1542.000000, y: -1336.000000, z: -327.917725 },
      ct_6: { x: 1342.000000, y: -1431.000000, z: -327.246643 },
      ct_7: { x: 1496.000000, y: -1424.000000, z: -327.740234 },
      ct_8: { x: 1600.000000, y: -1440.000000, z: -327.963867 },
    },

  };

  constructor(context) {
    this.context = context;
  }

  toggleSpawnerVisibility() {
    if (this.spawners_visible)
      this.hideAllSpawners();

    else
      this.showAllSpawners();
  }


  hideAllSpawners() {
    if (!this.spawners_visible)
      return;

    for (const spawn_id in this.spawners) {
      const spawner = this.spawners[spawn_id];
      const spawner_model = spawner.getModel();
      spawner_model.Unglow();
    }

    this.spawners_visible = false;

    this.context.uiManager.setNotificationMessage("Spawnpoint teleporters hidden");
  }

  showAllSpawners() {
    // TODO: Causes invisible spawners on /restart
    // if (this.spawners_visible)
    //   return;

    for (const spawn_id in this.spawners) {
      const spawner = this.spawners[spawn_id];
      const spawner_model = spawner.getModel();

      const glow_color = this.getGlowColor(spawn_id);
      spawner_model.Glow(glow_color);
    }

    this.spawners_visible = true;

    this.context.uiManager.setNotificationMessage("Spawnpoint teleporters revealed");
  }

  getGlowColor(spawn_id) {
    const [team, number] = spawn_id.split("_");

    if (team === "ct")
      return Color.LIGHT_BLUE;
    else
      return Color.ORANGE;
  }

  moveEnoughSpawnersToSpawns() {
    this.spawners = this.getEnoughSpawners();

    for (const spawn_id in this.spawners) {
      const spawner = this.spawners[spawn_id];
      this.moveSpawnerToSpawnpoint(spawner);
    }

    this.showAllSpawners();
  }

  getEnoughSpawners() {
    const spawners = {};
    const map = Instance.GetMapName();

    const spawners_needed = Object.keys(this.spawnpoints[map]);

    for (const spawn_id of spawners_needed) {
      try {
        const spawner = this.getSpawner(spawn_id);
        spawners[spawn_id] = spawner;

      } catch {
        break; // Break early if ran out of spawners
      }
    }

    return spawners;
  }

  getSpawner(spawn_id) {
    const spawner_model = Instance.FindEntityByName(`spawner_model_${spawn_id}`);
    const spawner_button = spawner_model.GetParent();

    if (!spawner_model || !spawner_button)
      throw new CustomError("Ran out of spawners.");

    const spawner = new Spawner(spawner_button, spawner_model);

    return spawner;
  }

  moveSpawnerToSpawnpoint(spawner) {
    const spawn_id = this.getSpawnId(spawner);
    const spawnpoint = this.getSpawnpoint(spawn_id);

    this.teleportSpawner(spawner, spawnpoint);
  }

  teleportSpawner(spawner, spawnpoint) {
    Instance.Msg(`Teleport spawner ${this.getSpawnId(spawner)} to ${spawnpoint.x} ${spawnpoint.y} ${spawnpoint.z}`);

    const spawner_button = spawner.getButton();

    // Note: spawner_button is parent of spawner_model, so teleporting the button also teleports the model
    spawner_button.Teleport({
      position: spawnpoint,
      velocity: ZERO_VELOCITY_VECTOR,
    });

    // Rotate spawner model to face (0,0)
    const angles_to_world_center = this.getAnglesFromPointToWorldCenter(spawnpoint);
    const spawner_model = spawner.getModel();

    spawner_model.Teleport({
      angles: angles_to_world_center,
    });
  }

  getAnglesFromPointToWorldCenter({ x, y, z }) {
    const vector_to_world_center = CoordinateManager.getReverseVector({ x, y, z });

    // Angles to (0, 0, 0)
    const angles_to_world_center = CoordinateManager.vectorToAngles(vector_to_world_center);

    // Remove pitch component to prevent Michael Jackson lean
    angles_to_world_center.pitch = 0;

    return angles_to_world_center;
  }

  getSpawnIdFromButtonEntity(button_entity) {
    return button_entity.GetEntityName().replace("spawner_button_", "");
  }

  getSpawnId(spawner) {
    const spawner_button = spawner.getButton();
    return spawner_button.GetEntityName().replace("spawner_button_", "");
  }

  getSpawnpoint(spawn_id) {
    const map = Instance.GetMapName();

    return this.spawnpoints[map][spawn_id];
  }

  handleSpawnerTriggered({ caller }) {
    if (!this.spawners_visible)
      return;

    const spawn_id = this.getSpawnIdFromButtonEntity(caller);
    const spawnpoint = this.getSpawnpoint(spawn_id);

    this.context.playerPawnManager.setLocation(spawnpoint);
    this.context.playerPawnManager.freezeAllPawnsForTicks(64);
  }
}

class CoordinateManager {
  static getMagnitude({ x, y, z }) {
    return Math.sqrt(
      (x ** 2) +
      (y ** 2) +
      (z ** 2)
    );
  }

  static getHorizontalMagnitude({ x, y, z }) {
    return Math.sqrt(
      (x ** 2) +
      (y ** 2)
    );
  }

  static getNormalizedVector({ x, y, z }) {
    const magnitude = this.getMagnitude({ x, y, z });

    return {
      x: (x / magnitude),
      y: (y / magnitude),
      z: (z / magnitude),
    };
  }

  static getReverseVector({ x, y, z }) {
    return {
      x: -x,
      y: -y,
      z: -z,
    };
  }

  static radiansToDegrees(radians) {
    return radians * 180 / Math.PI;
  }

  static vectorToAngles({ x, y, z }) {
    const normalized_vector = this.getNormalizedVector({ x, y, z });
    const horizontal_magnitude = this.getHorizontalMagnitude(normalized_vector);

    const pitch = Math.atan2(-normalized_vector.z, horizontal_magnitude);
    const yaw = Math.atan2(normalized_vector.y, normalized_vector.x);

    return {
      pitch: this.radiansToDegrees(pitch),
      yaw: this.radiansToDegrees(yaw),
      roll: 0,
    };
  }
}

class EasyAnno {
  constructor(context) {
    this.context = context;
  }

  validateGrenadeHasBeenCached() {
    if (this.context.lineupCache.isEmpty())
      throw new CustomError("You haven't thrown any grenades yet.\nThrow a grenade first, then use /autoadd, /addlastthrow, or /addnextthrow to annotate it.");
  }

  cleanup() {
    const cleanup_command = `
      ent_fire smokegrenade_projectile kill;
      ent_fire molotov_projectile kill;
      ent_fire inferno kill;
      ent_fire flashbang_projectile kill;
      ent_fire hegrenade_projectile kill;
      ent_fire decoy_projectile kill;
      stopsound
      `;

    Instance.ServerCommand(cleanup_command);

    this.context.uiManager.setNotificationMessage("Cleaned up live grenades.");
  }

  rethrow() {
    this.validateGrenadeHasBeenCached();
    Instance.ServerCommand("sv_rethrow_last_grenade ");
    this.context.uiManager.setNotificationMessage("Re-throwing last grenade you threw");
  }

  undoLastAnnotation() {
    Instance.ServerCommand("annotation_delete_previous_node_set");
    this.context.storageManager.has_unsaved_changes = true;
    this.context.uiManager.setNotificationMessage("Removed last annotation");
    this.context.soundEffectPlayer.play(SoundEffect.REMOVE_ANNOTATION);
  }

  addSpot() {
    Instance.ServerCommand("annotation_create spot");
    this.context.storageManager.has_unsaved_changes = true;
  }

  addText(title, description) {
    if (!title && !description)
      throw new CustomError("You may omit title OR description, but not both.");

    if (!title)
      title = "";

    if (!description)
      description = "";

    Instance.ServerCommand(`annotation_create text "${title}" "${description}" float true`);

    this.context.storageManager.has_unsaved_changes = true;
  }

  // Teleport to lineupcache.position and create annotation
  createAnnotationFromCachedThrowPosition(label) {
    this.validateGrenadeHasBeenCached();

    if (this.context.lineupCache.was_moving)
      throw new CustomError("You may have been moving while throwing the previous grenade.\n/autoadd doesn't work properly for moving throws.\nTry /addnextthrow (/ant) or /addlastthrow (/alt) instead.");

    this.context.uiManager.setNotificationMessage("Auto-annotating last thrown grenade...");

    // Teleport to last throw position and freeze player
    const TICKS_TO_FREEZE = 72;

    const playerPawnManager = this.context.playerPawnManager;
    const position = this.context.lineupCache.position;
    const grenade_type = this.context.lineupCache.grenade_type;

    playerPawnManager.setPosition(position);
    playerPawnManager.freezeMouseMovementForTicks(TICKS_TO_FREEZE, position.angles);
    playerPawnManager.freezeAllPawnsForTicks(TICKS_TO_FREEZE);

    if (position.isCrouched)
      playerPawnManager.crouchForTicks(TICKS_TO_FREEZE);

    // Schedule creation of annotation
    const ANNOTATE_DELAY = 64;

    const annotation_job = new AnnotationJob({
      context: this.context,
      grenade_type: grenade_type,
      label: label,
      message: "Auto-annotated last-thrown grenade",
    });

    this.context.scheduler.addTask(ANNOTATE_DELAY, () => annotation_job.run());

    this.context.storageManager.has_unsaved_changes = true;
  }

  // Create annotation using player's CURRENT position (without teleporting), but LAST-THROWN grenade's DESTINATION
  createAnnotationUsingCurrentPosition(label, message = null) {
    this.validateGrenadeHasBeenCached();

    // Allow #handleGunfire to override message (created using /addnextshot), otherwise use default message (regular /add command)
    if (!message)
      message = "Annotated last-thrown grenade using current position";

    // Create annotation without teleporting to last throw position
    const annotation_job = new AnnotationJob({
      context: this.context,
      grenade_type: this.context.lineupCache.grenade_type,
      label: label,
      message: message,
    });

    annotation_job.run();

    this.context.storageManager.has_unsaved_changes = true;
  }

  primeAddNextThrow(label) {
    this.context.lineupCache.setPosition();
    this.context.lineupCache.saved_label = label;
    this.context.lineupCache.waiting_for_throw = true;

    const message = "/addnextthrow has been primed. Throw the grenade and it will be automatically annotated.";
    this.context.uiManager.setNotificationMessage(message);
  }

  handleGrenadeThrow({ projectile }) {
    const lineupCache = this.context.lineupCache;

    // /addnextthrow has been primed
    if (lineupCache.waiting_for_throw) {
      lineupCache.waiting_for_throw = false;
      lineupCache.setFromGrenadeProjectile(projectile);

      this.context.uiManager.setNotificationMessage("Grenade thrown, creating annotation...");
      this.context.scheduler.addTask(64,
        () => this.createAnnotationFromCachedThrowPosition(lineupCache.saved_label)
      );

    } else {
      lineupCache.setFromGrenadeProjectile(projectile);
      lineupCache.setPosition();
    }
  }

  primeAddNextShot(label) {
    this.validateGrenadeHasBeenCached();

    this.context.lineupCache.saved_label = label;
    this.context.lineupCache.waiting_for_gunshot = true;

    const message = "/addnextshot has been primed.\nReturn the the original lineup position, then fire any weapon to create an annotation.";
    this.context.uiManager.setNotificationMessage(message);
  }

  handleGunfire() {
    // /addshot has been primed
    if (this.context.lineupCache.waiting_for_gunshot) {
      this.createAnnotationUsingCurrentPosition(
        this.context.lineupCache.saved_label,
        "Annotated last-thrown grenade using gunshot direction"
      );

      this.context.lineupCache.waiting_for_gunshot = false;
    }
  }

  clearAllAnnotations() {
    Instance.ServerCommand("annotation_clear");
    this.context.uiManager.setNotificationMessage("Cleared all annotations.");
    this.context.storageManager.has_unsaved_changes = true;
    this.context.soundEffectPlayer.play(SoundEffect.REMOVE_ANNOTATION);
  }
}

class EasyAnnoContext {
  lineupCache;
  playerPawnManager;
  scheduler;
  uiManager;
  helpMenu;
  chatManager;
  storageManager;
  serverManager;
  spawnerManager;
  easyAnno;
}

const context = new EasyAnnoContext();

context.lineupCache = new LineupCache(context);
context.playerPawnManager = new PlayerPawnManager(context);
context.scheduler = new Scheduler(context);
context.uiManager = new UIManager(context);
context.soundEffectPlayer = new SoundEffectPlayer(context);
context.helpMenu = new HelpMenu(context);
context.chatManager = new ChatManager(context);
context.storageManager = new StorageManager(context);
context.serverManager = new ServerManager(context);
context.spawnerManager = new SpawnerManager(context);
context.easyAnno = new EasyAnno(context);

Instance.OnGrenadeThrow(
  (e) => context.easyAnno.handleGrenadeThrow(e)
);

Instance.OnGunFire(
  (e) => context.easyAnno.handleGunfire()
);

Instance.OnPlayerChat(
  (e) => context.chatManager.handlePlayerChat(e)
);

Instance.OnScriptInput("spawner_triggered",
  (e) => context.spawnerManager.handleSpawnerTriggered(e)
);

Instance.OnPlayerKill(
  (e) => context.chatManager.showReloadTip()
);

// Initial setup
Instance.OnActivate(() => {
  context.serverManager.setupServer();
});

Instance.OnRoundStart(() => {
  // Note: Putting this here instead of OnActivate prevents bug where spawners don't
  // move to positions (probably because entities don't exist yet at time of OnActivate)
  context.spawnerManager.moveEnoughSpawnersToSpawns();

  loadDefaultAnnotationsOnStartOrRestart();
  showWelcomeMessageOnStartOrRestart();
});

function loadDefaultAnnotationsOnStartOrRestart() {
  Instance.Msg("Loading default annotations.");
  context.storageManager.loadDefaultAnnotationFile();
}

function showWelcomeMessageOnStartOrRestart() {
  const is_first_round = Instance.GetRoundsPlayed() === 0;

  if (is_first_round)
    context.uiManager.showWelcomeMessage();
}

// Main loop
Instance.SetThink(() => {
  context.scheduler.tick();
  context.uiManager.draw();

  Instance.SetNextThink(Instance.GetGameTime());
});

Instance.SetNextThink(Instance.GetGameTime());