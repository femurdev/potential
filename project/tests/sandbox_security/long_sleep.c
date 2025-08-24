#include <stdio.h>
#include <unistd.h>

int main() {
    // Sleep for a long time to exercise runner timeouts
    sleep(1000);
    printf("SLEPT\n");
    return 0;
}
