/* Test-only POSIX primitives missing from Node's filesystem API. A preflight
 * exists() followed by fs.rename() is not an exclusive rename. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "rename") == 0) {
        int result;
#if defined(__APPLE__)
        result = renamex_np(argv[2], argv[3], RENAME_EXCL);
#elif defined(__linux__)
        result = syscall(SYS_renameat2, AT_FDCWD, argv[2], AT_FDCWD, argv[3], 1 /* RENAME_NOREPLACE */);
#else
#error "The real filesystem tests require macOS or Linux"
#endif
        if (result != 0) { perror("exclusive rename"); return 1; }
        return 0;
    }
    fprintf(stderr, "usage: native-fs rename FROM TO\n");
    return 2;
}
