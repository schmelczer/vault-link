use std::sync::LazyLock;

use regex::Regex;

static DEDUP_SUFFIX_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" \((\d+)\)$").expect("invalid regex"));

pub fn dedup_paths(path: &str) -> impl Iterator<Item = String> {
    let mut path_parts = path.split('/').collect::<Vec<_>>();
    let file_name = path_parts
        .pop()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_owned();

    let mut directory = path_parts.join("/");
    if !directory.is_empty() {
        directory.push('/');
    }

    // Handle dotfiles: ".gitignore" should have no extension, ".config.json" should split as ".config" + ".json"
    let is_simple_dotfile = file_name.starts_with('.') && file_name.matches('.').count() == 1;

    let (stem, extension) = if is_simple_dotfile {
        (file_name.clone(), String::new())
    } else {
        // Regular file or dotfile with extension
        let name_parts = file_name.rsplitn(2, '.').collect::<Vec<_>>();
        let mut reverse_parts = name_parts.into_iter().rev();
        match (reverse_parts.next(), reverse_parts.next()) {
            (Some(stem), maybe_extension) => (
                stem.to_owned(),
                maybe_extension
                    .map(|ext| format!(".{ext}"))
                    .unwrap_or_default(),
            ),
            _ => unreachable!("Path must have at least one part"),
        }
    };

    let start_number = DEDUP_SUFFIX_REGEX
        .captures(&stem)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .unwrap_or(0);

    let clean_stem = DEDUP_SUFFIX_REGEX.replace(&stem, "").to_string();

    (start_number..).map(move |dedup_number| {
        if dedup_number == 0 {
            format!("{directory}{clean_stem}{extension}")
        } else {
            format!("{directory}{clean_stem} ({dedup_number}){extension}")
        }
    })
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_dedup_paths() {
        let mut deduped = dedup_paths("file.txt");
        assert_eq!(deduped.next(), Some("file.txt".to_owned()));
        assert_eq!(deduped.next(), Some("file (1).txt".to_owned()));
        assert_eq!(deduped.next(), Some("file (2).txt".to_owned()));

        let mut deduped = dedup_paths("file");
        assert_eq!(deduped.next(), Some("file".to_owned()));
        assert_eq!(deduped.next(), Some("file (1)".to_owned()));
        assert_eq!(deduped.next(), Some("file (2)".to_owned()));

        let mut deduped = dedup_paths("file (51).md");
        assert_eq!(deduped.next(), Some("file (51).md".to_owned()));
        assert_eq!(deduped.next(), Some("file (52).md".to_owned()));
        assert_eq!(deduped.next(), Some("file (53).md".to_owned()));

        let mut deduped = dedup_paths("file (5)");
        assert_eq!(deduped.next(), Some("file (5)".to_owned()));
        assert_eq!(deduped.next(), Some("file (6)".to_owned()));
        assert_eq!(deduped.next(), Some("file (7)".to_owned()));

        let mut deduped = dedup_paths("my/path.with.dots/file (5).md");
        assert_eq!(
            deduped.next(),
            Some("my/path.with.dots/file (5).md".to_owned())
        );
        assert_eq!(
            deduped.next(),
            Some("my/path.with.dots/file (6).md".to_owned())
        );

        let mut deduped = dedup_paths("my/path.with.dots/file (5)");
        assert_eq!(
            deduped.next(),
            Some("my/path.with.dots/file (5)".to_owned())
        );
        assert_eq!(
            deduped.next(),
            Some("my/path.with.dots/file (6)".to_owned())
        );
    }

    #[test]
    fn test_regex_capturing_group() {
        // Single digit in parentheses
        let mut deduped = dedup_paths("document (5).md");
        assert_eq!(deduped.next(), Some("document (5).md".to_owned()));
        assert_eq!(deduped.next(), Some("document (6).md".to_owned()));
        assert_eq!(deduped.next(), Some("document (7).md".to_owned()));

        // Multi-digit number
        let mut deduped = dedup_paths("report (123).pdf");
        assert_eq!(deduped.next(), Some("report (123).pdf".to_owned()));
        assert_eq!(deduped.next(), Some("report (124).pdf".to_owned()));
        assert_eq!(deduped.next(), Some("report (125).pdf".to_owned()));

        // Number without extension
        let mut deduped = dedup_paths("folder (99)");
        assert_eq!(deduped.next(), Some("folder (99)".to_owned()));
        assert_eq!(deduped.next(), Some("folder (100)".to_owned()));
        assert_eq!(deduped.next(), Some("folder (101)".to_owned()));
    }

    #[test]
    fn test_dedup_dotfiles() {
        // Simple dotfile (no extension)
        let mut deduped = dedup_paths(".gitignore");
        assert_eq!(deduped.next(), Some(".gitignore".to_owned()));
        assert_eq!(deduped.next(), Some(".gitignore (1)".to_owned()));
        assert_eq!(deduped.next(), Some(".gitignore (2)".to_owned()));

        // Dotfile with extension
        let mut deduped = dedup_paths(".config.json");
        assert_eq!(deduped.next(), Some(".config.json".to_owned()));
        assert_eq!(deduped.next(), Some(".config (1).json".to_owned()));
        assert_eq!(deduped.next(), Some(".config (2).json".to_owned()));

        // Dotfile with number
        let mut deduped = dedup_paths(".gitignore (5)");
        assert_eq!(deduped.next(), Some(".gitignore (5)".to_owned()));
        assert_eq!(deduped.next(), Some(".gitignore (6)".to_owned()));
        assert_eq!(deduped.next(), Some(".gitignore (7)".to_owned()));

        // Dotfile with extension and number
        let mut deduped = dedup_paths(".config (3).json");
        assert_eq!(deduped.next(), Some(".config (3).json".to_owned()));
        assert_eq!(deduped.next(), Some(".config (4).json".to_owned()));
        assert_eq!(deduped.next(), Some(".config (5).json".to_owned()));

        // Dotfile in subdirectory
        let mut deduped = dedup_paths("my/path/.gitignore");
        assert_eq!(deduped.next(), Some("my/path/.gitignore".to_owned()));
        assert_eq!(deduped.next(), Some("my/path/.gitignore (1)".to_owned()));
        assert_eq!(deduped.next(), Some("my/path/.gitignore (2)".to_owned()));
    }
}
