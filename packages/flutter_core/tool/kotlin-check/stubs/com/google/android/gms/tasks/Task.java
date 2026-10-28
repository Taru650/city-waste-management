package com.google.android.gms.tasks;
// Compile-only stub of play-services-tasks (Google Maven is unreachable here). Mirrors the public API used.
public abstract class Task<T> {
  public abstract Task<T> addOnSuccessListener(OnSuccessListener<? super T> l);
  public abstract Task<T> addOnFailureListener(OnFailureListener l);
}
