#define FEATURE_ENABLED 1 // trailing text must not become the define value
#if FEATURE_ENABLED // trailing text must not break condition evaluation
#define ACTIVE_FROM_LINE_COMMENTED_IF 42
#endif