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
        match file_name.rsplit_once('.') {
            Some((stem, extension)) => (stem.to_owned(), format!(".{extension}")),
            None => (file_name.clone(), String::new()),
        }
    };

    let (clean_stem, start_number) = strip_dedup_suffix(&stem);
    let clean_stem = clean_stem.to_owned();

    std::iter::successors(Some(start_number), |dedup_number| {
        dedup_number.checked_add(1)
    })
    .map(move |dedup_number| {
        if dedup_number == 0 {
            format!("{directory}{clean_stem}{extension}")
        } else {
            format!("{directory}{clean_stem} ({dedup_number}){extension}")
        }
    })
}

fn strip_dedup_suffix(stem: &str) -> (&str, u64) {
    let Some(without_closing_paren) = stem.strip_suffix(')') else {
        return (stem, 0);
    };
    let Some((clean_stem, number)) = without_closing_paren.rsplit_once(" (") else {
        return (stem, 0);
    };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return (stem, 0);
    }

    (clean_stem, number.parse::<u64>().unwrap_or(0))
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
    fn test_dedup_suffix_parsing() {
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
