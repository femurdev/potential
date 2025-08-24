#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <errno.h>

int main() {
    int s = socket(AF_INET, SOCK_RAW, 0);
    if (s == -1) {
        // expected to fail in a restricted sandbox
        printf("FORBIDDEN_BLOCKED: %d\n", errno);
        return 0;
    } else {
        printf("FORBIDDEN_ALLOWED\n");
        close(s);
        return 0;
    }
}
