/** Column types shared by the migrations, so every id and timestamp is declared the same way. */
export const ID = 'char(36) character set ascii collate ascii_bin';
export const TS = 'datetime(3)';
export const NOW = 'default current_timestamp(3)';
export const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';
